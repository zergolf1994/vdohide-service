import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import { DomainStatus } from "@/core/enums";
import { CustomDomainModel } from "@/db/models";

const DOMAIN_BATCH_SIZE = 20;
const CONCURRENCY = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10 * 60 * 1000;
const ACTIVE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LOCK_DURATION_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;
const MAX_RESPONSE_BYTES = 8 * 1024;

type HealthPayload = {
    status?: unknown;
    service?: unknown;
    host?: unknown;
    slug?: unknown;
};

const normalizeHost = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");

const isPrivateIPv4 = (address: string) => {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return true;
    }

    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
    );
};

const isPrivateAddress = (address: string) => {
    const kind = isIP(address);
    if (kind === 4) return isPrivateIPv4(address);
    if (kind !== 6) return true;

    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
        return isPrivateIPv4(normalized.slice("::ffff:".length));
    }

    return (
        normalized === "::" ||
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        /^fe[89ab]/.test(normalized) ||
        normalized.startsWith("ff")
    );
};

const resolvePublicAddress = async (host: string) => {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) throw new Error("domain has no DNS address");
    if (addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error("domain resolves to a private or reserved address");
    }
    // Prefer IPv4 because some service hosts advertise AAAA while the machine
    // running this verifier has no working outbound IPv6 route.
    return addresses.find(({ family }) => family === 4) ?? addresses[0];
};

const requestHealth = async (host: string): Promise<HealthPayload> => {
    if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) {
        throw new Error("invalid domain name");
    }

    const address = await resolvePublicAddress(host);

    return new Promise((resolve, reject) => {
        const request = https.request(
            {
                hostname: host,
                port: 443,
                path: "/health",
                method: "GET",
                servername: host,
                headers: {
                    Accept: "application/json",
                    "User-Agent": "vdohide-service/domain-verifier",
                },
                lookup: ((_hostname: string, options: { all?: boolean }, callback: Function) => {
                    if (options?.all) {
                        callback(null, [address]);
                        return;
                    }
                    callback(null, address.address, address.family);
                }) as any,
            },
            (response) => {
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`health returned HTTP ${response.statusCode ?? 0}`));
                    return;
                }

                const chunks: Buffer[] = [];
                let size = 0;

                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        request.destroy(new Error("health response is too large"));
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on("end", () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as HealthPayload);
                    } catch {
                        reject(new Error("health returned invalid JSON"));
                    }
                });
            }
        );

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error("health request timed out"));
        });
        request.on("error", reject);
        request.end();
    });
};

const dueFilter = (now: Date) => ({
    enable: true,
    status: { $in: [DomainStatus.PENDING, DomainStatus.ACTIVE] },
    $and: [
        {
            $or: [
                { spaceId: { $exists: true, $nin: [null, ""] } },
                { creatorId: { $exists: true, $nin: [null, ""] } },
            ],
        },
        {
            $or: [
                { "dns.nextVerifyAt": { $exists: false } },
                { "dns.nextVerifyAt": { $lte: now } },
            ],
        },
        {
            $or: [
                { "dns.checkLockedUntil": { $exists: false } },
                { "dns.checkLockedUntil": { $lte: now } },
            ],
        },
    ],
});

const errorReason = (error: unknown) =>
    (error instanceof Error ? error.message : "health verification failed").slice(0, 300);

export const verifyCustomDomains = async () => {
    const startedAt = new Date();

    try {
        const candidates = await CustomDomainModel.find(dueFilter(startedAt))
            .sort({ "dns.nextVerifyAt": 1, _id: 1 })
            .limit(DOMAIN_BATCH_SIZE)
            .select({ _id: 1 })
            .lean();

        if (candidates.length === 0) {
            return { message: "No custom domains ready for verification" };
        }

        const result = { checked: 0, activated: 0, healthy: 0, retrying: 0, failed: 0 };
        let cursor = 0;

        const worker = async () => {
            while (cursor < candidates.length) {
                const candidate = candidates[cursor++];
                const checkedAt = new Date();
                const lockUntil = new Date(checkedAt.getTime() + LOCK_DURATION_MS);

                const domain = await CustomDomainModel.findOneAndUpdate(
                    { _id: candidate._id, ...dueFilter(checkedAt) },
                    { $set: { "dns.checkLockedUntil": lockUntil } },
                    { returnDocument: "after" }
                )
                    .select({ _id: 1, name: 1, slug: 1, status: 1, dns: 1 })
                    .lean();

                if (!domain) continue;
                result.checked++;

                const host = normalizeHost(domain.name);
                try {
                    const health = await requestHealth(host);
                    if (
                        health.status !== "ok" ||
                        health.service !== "player-node" ||
                        typeof health.host !== "string" ||
                        normalizeHost(health.host) !== host ||
                        health.slug !== domain.slug
                    ) {
                        throw new Error("health host or slug does not match");
                    }

                    const update = await CustomDomainModel.updateOne(
                        { _id: domain._id, enable: true, "dns.checkLockedUntil": lockUntil },
                        {
                            $set: {
                                status: DomainStatus.ACTIVE,
                                "dns.retryCount": 0,
                                "dns.lastCheckedAt": checkedAt,
                                "dns.lastVerified": checkedAt,
                                "dns.nextVerifyAt": new Date(checkedAt.getTime() + ACTIVE_CHECK_INTERVAL_MS),
                            },
                            $unset: {
                                "dns.checkLockedUntil": 1,
                                "dns.reason": 1,
                            },
                        }
                    );

                    if (update.modifiedCount > 0) {
                        if (domain.status === DomainStatus.ACTIVE) {
                            result.healthy++;
                        } else {
                            result.activated++;
                            console.log(`[verify:domains] activated ${host}`);
                        }
                    }
                } catch (error) {
                    const retryCount = (domain.dns?.retryCount ?? 0) + 1;
                    const failed = retryCount >= MAX_RETRIES;
                    const reason = errorReason(error);

                    const update = await CustomDomainModel.updateOne(
                        { _id: domain._id, enable: true, "dns.checkLockedUntil": lockUntil },
                        {
                            $set: {
                                ...(failed ? { status: DomainStatus.FAILED } : {}),
                                "dns.retryCount": retryCount,
                                "dns.lastCheckedAt": checkedAt,
                                "dns.reason": reason,
                                ...(!failed
                                    ? {
                                        "dns.nextVerifyAt": new Date(
                                            checkedAt.getTime() + RETRY_DELAY_MS
                                        ),
                                    }
                                    : {}),
                            },
                            $unset: {
                                "dns.checkLockedUntil": 1,
                                ...(failed ? { "dns.nextVerifyAt": 1 } : {}),
                            },
                        }
                    );

                    if (update.modifiedCount > 0) {
                        if (failed) {
                            result.failed++;
                            console.warn(`[verify:domains] stopped ${host} after ${retryCount} failures: ${reason}`);
                        } else {
                            result.retrying++;
                            console.warn(`[verify:domains] retry ${retryCount}/${MAX_RETRIES} for ${host}: ${reason}`);
                        }
                    }
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker())
        );

        return { message: "Success", data: result };
    } catch (error) {
        console.error("verifyCustomDomains -> Error:", error);
        return { message: "Internal server error" };
    }
};
