import {
    S3Client,
    ListObjectVersionsCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

// helper ร่วมสำหรับ cleanup S3 ของ media/ingest — versioning-aware
// (bucket ที่เปิด versioning เช่น Backblaze B2 ต้องลบระบุ VersionId ไม่งั้น
//  DeleteObject จะแค่ "hide" สร้าง delete marker ไฟล์จริงยังค้าง)

export type VersionRef = { Key: string; VersionId?: string };

const DELETE_CHUNK = 1000; // เพดานของ DeleteObjects ต่อ request

// S3 client ต่อ storage — ผู้เรียก cache เอง (ไม่ข้ามรอบ กัน config เก่าค้าง)
export const s3ClientFor = (storage: any): S3Client => {
    const cfg = storage.s3 ?? {};
    let endpoint: string | undefined = cfg.endpoint || undefined;
    if (endpoint && !endpoint.startsWith("http")) {
        endpoint = "https://" + endpoint;
    }
    return new S3Client({
        endpoint,
        region: cfg.region || "auto",
        credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
        },
        forcePathStyle: !!cfg.forcePathStyle,
    });
};

// เติม s3.prefix ให้ key (ถ้ายังไม่มี) + ตัด "/" ท้ายทิ้ง
export const applyPrefix = (rawKey: string, prefix: string): string => {
    let key = rawKey;
    if (prefix && !key.startsWith(prefix)) {
        key = prefix.replace(/\/+$/, "") + "/" + key;
    }
    return key.replace(/\/+$/, "");
};

// provider ไม่รองรับ versioning API (เช่น MinIO บางตัว) → 501 NotImplemented
const isVersioningUnsupported = (err: any): boolean => {
    const code = err?.name || err?.Code;
    const status = err?.$metadata?.httpStatusCode;
    return code === "NotImplemented" || code === "MethodNotAllowed" || status === 501;
};

// list "ทุก object ที่ต้องลบ" ของ base — ครอบทั้ง exact key (ไฟล์เดียว) และ
// โฟลเดอร์ (HLS = m3u8 + segments) — paginate จนหมด
// กรอง Key === base หรือ base + "/" เท่านั้น (กัน prefix ชน เช่น 720 ไปโดน 7200)
//
// พยายาม ListObjectVersions ก่อน (bucket ที่เปิด versioning เช่น B2 ต้องลบทุก
// version + delete marker ไม่งั้นแค่ hide) — ถ้า provider ไม่รองรับ (501) →
// fallback เป็น ListObjectsV2 (current version, VersionId undefined) เหมือน Go
export const listAllVersions = async (
    client: S3Client,
    bucket: string,
    base: string,
): Promise<VersionRef[]> => {
    const items: VersionRef[] = [];
    const keep = (k?: string) => !!k && (k === base || k.startsWith(base + "/"));

    try {
        let keyMarker: string | undefined = undefined;
        let versionMarker: string | undefined = undefined;
        do {
            const out: any = await client.send(new ListObjectVersionsCommand({
                Bucket: bucket,
                Prefix: base,
                KeyMarker: keyMarker,
                VersionIdMarker: versionMarker,
            }));
            for (const v of out.Versions ?? []) {
                if (keep(v.Key)) items.push({ Key: v.Key, VersionId: v.VersionId });
            }
            // delete marker เก่า (ตัว "hidden") ต้องลบด้วย ไฟล์ถึงจะหายจาก listing
            for (const d of out.DeleteMarkers ?? []) {
                if (keep(d.Key)) items.push({ Key: d.Key, VersionId: d.VersionId });
            }
            keyMarker = out.IsTruncated ? out.NextKeyMarker : undefined;
            versionMarker = out.IsTruncated ? out.NextVersionIdMarker : undefined;
        } while (keyMarker);

        return items;
    } catch (err) {
        if (!isVersioningUnsupported(err)) throw err;

        // ── fallback: provider ไม่รองรับ versioning → list current version อย่างเดียว ──
        items.length = 0;
        let token: string | undefined = undefined;
        do {
            const out: any = await client.send(new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: base,
                ContinuationToken: token,
            }));
            for (const obj of out.Contents ?? []) {
                if (keep(obj.Key)) items.push({ Key: obj.Key }); // ไม่มี VersionId — ลบ current
            }
            token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } while (token);

        return items;
    }
};

// ลบเป็นชุด (สูงสุด 1000/request) ระบุ VersionId → ลบถาวรจริง — โยน error ถ้าล้ม
export const deleteVersions = async (
    client: S3Client,
    bucket: string,
    refs: VersionRef[],
) => {
    for (let i = 0; i < refs.length; i += DELETE_CHUNK) {
        const chunk = refs.slice(i, i + DELETE_CHUNK);
        const out: any = await client.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk, Quiet: true },
        }));
        if (out.Errors?.length) {
            throw new Error(`DeleteObjects: ${out.Errors.length} failed (${out.Errors[0]?.Key}: ${out.Errors[0]?.Message})`);
        }
    }
};
