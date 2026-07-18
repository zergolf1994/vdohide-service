import { AdsImageShowOn, DomainRecord, DomainStatus } from "../enums";
import { ResultUserData } from "./user.type";
import { ResultSpaceData } from "./workspace.type";

export type ResultDomain = {
    _id?: string;
    enable?: boolean;
    name?: string;
    status?: DomainStatus;
    workspace?: ResultSpaceData;
    creator?: ResultUserData;
    dns?: {
        recordType?: DomainRecord;
        value?: string;
        ttl?: number;
        verificationToken?: string;
        lastVerified?: Date;
    };
    player?: ResultPlayerSetting;
    adverts?: ResultDomainAdvert;
    date?: Date;
    createdAt?: Date;
};

export type ResultDomainData = {
    _id?: string;
    status?: DomainStatus;
    name?: string;
    isSystem?: boolean;
}


export type ResultPlayerSetting = {
    skin?: "netflix" | "youtube" | "other";
    logoImageUrl?: string;
    logoWebsiteUrl?: string;
    logoPosition?: string;
    posterUrl?: string;
    baseColor?: string;
    displayTitle?: boolean;
    autoPlay?: boolean;
    muteSound?: boolean;
    repeatVideo?: boolean;
    continuePlay?: boolean;
    continuePlayArk?: boolean;
    sharing?: boolean;
    captions?: boolean;
    playbackRate?: boolean;
    keyboard?: boolean;
    download?: boolean;
    pip?: boolean;
    showPreviewTime?: boolean;
    fastForward?: boolean;
    rewind?: boolean;
    seekStep?: number;
};

export type ResultDomainAdvertCategory = {
    enabled: boolean;
    list: ResultAdvert[];
};

export type ResultDomainAdvert = {
    video: ResultDomainAdvertCategory;
    image: ResultDomainAdvertCategory;
    script: ResultDomainAdvertCategory;
};


export type ResultAdvert = {
    _id?: string;
    enabled: boolean;
    name: string;
    // Video ad
    mp4Url?: string;
    skipSeconds?: number;
    // Image ad
    imageUrl?: string;
    showOn?: AdsImageShowOn[];
    // Shared
    websiteUrl?: string;
    // JavaScript ad
    script?: string;
};