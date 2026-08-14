import {
    buildDesktopUserAgentCondition,
    buildRefererBlockCondition,
    getAllowedRefererDomains,
} from './get-m3u8-referer-block-rule.service';

const SEGMENT_PATH_PATTERN = '/*/v-*.jpeg';

export const buildSegmentRefererBlockRule = (
    allowedDomains: string[]
): string => {
    return [
        '(',
        `  http.request.uri.path wildcard "${SEGMENT_PATH_PATTERN}" and`,
        `${buildDesktopUserAgentCondition('  ')} and`,
        buildRefererBlockCondition(allowedDomains, '  '),
        ')',
    ].join('\n');
};

export const getSegmentRefererBlockRule = async () => {
    const allowedDomains = await getAllowedRefererDomains();

    return {
        allowedDomains,
        rule: buildSegmentRefererBlockRule(allowedDomains),
    };
};
