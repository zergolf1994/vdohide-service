export enum DomainStatus {
    PENDING = "pending",
    ACTIVE = "active",
    FAILED = "failed",
    EXPIRED = "expired",
}

export enum SslStatus {
    PENDING = "pending",
    ACTIVE = "active",
    FAILED = "failed",
}

export enum DomainRecord {
    A = "a",
    CNAME = "cname",
    AAAA = "aaaa",
    TXT = "txt",
    MX = "mx",
    SRV = "srv",
    NS = "ns",
    PTR = "ptr",
    CAA = "caa",
    SPF = "spf",
    DMARC = "dmarc",
    DKIM = "dkim",
    SSHFP = "sshfp",
    TLSA = "tlsa",
    OPENPGPKEY = "openpgpkey",
    CERT = "cert",
    DNSKEY = "dnskey",
    DS = "ds",
    RRSIG = "rrsig",
    NSEC = "nsec",
    NSEC3 = "nsec3",
    NSEC3PARAM = "nsec3param",
    URI = "uri",
    HTTPS = "https",
    SVCB = "svcb",
}

export enum AdsImageShowOn {
    READY = "ready",
    END = "end",
    PAUSE = "pause",
}
