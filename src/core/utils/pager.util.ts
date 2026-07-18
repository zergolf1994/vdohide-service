// Pagination utility functions with enhanced features

// Constants
export const DEFAULT_PAGE = 1;
export const DEFAULT_PER_PAGE = 10;
export const MAX_PER_PAGE = 100;
export const MIN_PER_PAGE = 1;

// Sort orders
export const SORT_ORDER = {
    ASC: 'asc',
    DESC: 'desc'
} as const;

export type SortOrder = typeof SORT_ORDER[keyof typeof SORT_ORDER];

// Interfaces
export interface IPageLimit {
    page?: number;
    per_page?: number;
}

export interface IPaged {
    count: number | any[];
    per_page: number;
    page: number;
}

export interface IPaginationResult {
    current: number;
    count: number;
    items: number;
    show: string;
    hasNext: boolean;
    hasPrevious: boolean;
    nextPage: number | null;
    previousPage: number | null;
    pages: number[];
    startIndex: number;
    endIndex: number;
}

export interface ISortOptions {
    column?: string;
    order?: SortOrder;
    defaultColumn?: string;
    defaultOrder?: SortOrder;
}

// Additional types for better TypeScript support
export type PaginationData = IPaginationResult;

export type PageParams = {
    page: number;
    per_page: number;
    sort?: string;
};

export type PaginatedResponse<T = unknown> = {
    rows: T[];
    pager: IPaginationResult;
};

export type SortConfig = Record<string, 1 | -1>;

// Utility types for specific use cases
export type PageLimitResult = {
    skip: number;
    limit: number;
    page: number;
    per_page: number;
};

export type PageInfoResult = PageLimitResult & IPaginationResult;

// Validation functions
function validatePage(page?: number): number {
    if (!page || page < 1 || !Number.isInteger(page)) {
        return DEFAULT_PAGE;
    }
    return page;
}

function validatePerPage(per_page?: number): number {
    if (!per_page || per_page < MIN_PER_PAGE || per_page > MAX_PER_PAGE || !Number.isInteger(per_page)) {
        return DEFAULT_PER_PAGE;
    }
    return per_page;
}

function validateCount(count: number | any[]): number {
    // Handle array case (like MongoDB aggregation result)
    if (Array.isArray(count)) {
        if (count.length > 0 && typeof count[0] === 'object' && count[0].count !== undefined) {
            return validateCount(count[0].count);
        }
        return 0;
    }

    if (!count || count < 0 || !Number.isInteger(count)) {
        return 0;
    }
    return count;
}

// Enhanced page limit function
export function pageLimit({ page, per_page }: IPageLimit = {}): PageLimitResult {
    const validPage = validatePage(page);
    const validPerPage = validatePerPage(per_page);

    const startRow = validPage === 1 ? 0 : (validPage - 1) * validPerPage;

    return {
        skip: startRow,
        limit: validPerPage,
        page: validPage,
        per_page: validPerPage
    };
}

// Enhanced pagination function
export function paged({ count = 0, per_page, page }: IPaged): IPaginationResult {
    const validCount = validateCount(count);
    const validPage = validatePage(page);
    const validPerPage = validatePerPage(per_page);

    const totalPages = Math.ceil(validCount / validPerPage) || 1;
    const currentPage = Math.min(validPage, totalPages); // Ensure current page doesn't exceed total pages

    const startIndex = (currentPage - 1) * validPerPage + 1;
    const endIndex = Math.min(currentPage * validPerPage, validCount);
    const show = validCount > 0 ? `${startIndex}-${endIndex} of ${validCount}` : '0 of 0';

    const hasNext = currentPage < totalPages;
    const hasPrevious = currentPage > 1;
    const nextPage = hasNext ? currentPage + 1 : null;
    const previousPage = hasPrevious ? currentPage - 1 : null;

    // Generate page numbers for pagination UI (show up to 7 pages)
    const pages = generatePageNumbers(currentPage, totalPages);

    return {
        current: currentPage,
        count: totalPages,
        items: validCount,
        show,
        hasNext,
        hasPrevious,
        nextPage,
        previousPage,
        pages,
        startIndex: validCount > 0 ? startIndex : 0,
        endIndex: validCount > 0 ? endIndex : 0
    };
}

// Generate page numbers for pagination UI
function generatePageNumbers(current: number, total: number, maxVisible: number = 7): number[] {
    if (total <= maxVisible) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const pages: number[] = [];
    const half = Math.floor(maxVisible / 2);

    let start = Math.max(1, current - half);
    const end = Math.min(total, start + maxVisible - 1);

    // Adjust start if we're near the end
    if (end - start + 1 < maxVisible) {
        start = Math.max(1, end - maxVisible + 1);
    }

    for (let i = start; i <= end; i++) {
        pages.push(i);
    }

    return pages;
}

// Enhanced sorting function
export function sorted(sort: string = 'createdAt.desc', options: ISortOptions = {}): SortConfig {
    const {
        defaultColumn = 'createdAt',
        defaultOrder = SORT_ORDER.DESC
    } = options;

    if (!sort || typeof sort !== 'string') {
        return { [defaultColumn]: defaultOrder === SORT_ORDER.ASC ? 1 : -1 };
    }

    const [column, order] = sort.split('.');
    const validColumn = column?.trim() || defaultColumn;
    const validOrder = (order?.toLowerCase() === SORT_ORDER.ASC || order?.toLowerCase() === SORT_ORDER.DESC)
        ? order.toLowerCase() as SortOrder
        : defaultOrder;

    // Mapping of common sort columns
    const columnMap: Record<string, string> = {
        'name': 'name',
        'title': 'title',
        'size': 'size',
        'trash': 'trashedAt',
        'delete': 'deletedAt',
        'update': 'updatedAt',
        'create': 'createdAt',
        'date': 'createdAt',
        'email': 'email',
        'role': 'role',
        'status': 'status'
    };

    const mappedColumn = columnMap[validColumn] || validColumn;
    return { [mappedColumn]: validOrder === SORT_ORDER.ASC ? 1 : -1 };
}

// Utility functions
export function calculateOffset(page: number, perPage: number): number {
    return (validatePage(page) - 1) * validatePerPage(perPage);
}

export function calculatePageFromOffset(offset: number, perPage: number): number {
    return Math.floor(offset / validatePerPage(perPage)) + 1;
}

export function getPageInfo(page: number, perPage: number, totalItems: number): PageInfoResult {
    const validPage = validatePage(page);
    const validPerPage = validatePerPage(perPage);
    const validTotal = validateCount(totalItems);

    return {
        ...pageLimit({ page: validPage, per_page: validPerPage }),
        ...paged({ count: validTotal, per_page: validPerPage, page: validPage })
    };
}

// URL query string helpers
export function parsePageParams(searchParams: URLSearchParams): PageParams {
    const page = parseInt(searchParams.get('page') || '1');
    const per_page = parseInt(searchParams.get('per_page') || String(DEFAULT_PER_PAGE));
    const sort = searchParams.get('sort') || undefined;

    return {
        page: validatePage(page),
        per_page: validatePerPage(per_page),
        sort
    };
}

export function buildPageParams(page: number, perPage: number, sort?: string): URLSearchParams {
    const params = new URLSearchParams();

    if (page > 1) params.set('page', String(page));
    if (perPage !== DEFAULT_PER_PAGE) params.set('per_page', String(perPage));
    if (sort) params.set('sort', sort);

    return params;
}
