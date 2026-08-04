/**
 * Pagination utilities
 */

export interface PaginationInfo {
  currentPage: number;
  /**
   * `false` for lookahead pagination, where counting every matching row
   * would cost more than the page itself.
   */
  totalsExact: boolean;
  /** Null when the caller intentionally avoids an exact count. */
  totalPages: number | null;
  /** Null when the caller intentionally avoids an exact count. */
  totalItems: number | null;
  pageSize: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevUrl: string | null;
  nextUrl: string | null;
  pages: number[];
}

/**
 * Calculate pagination info
 */
export function paginate(
  totalItems: number,
  currentPage: number,
  pageSize: number,
  baseUrl: string,
  maxVisible = 10
): PaginationInfo {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const page = Math.min(Math.max(1, currentPage), totalPages);

  // Calculate visible page numbers
  let start = Math.max(1, page - Math.floor(maxVisible / 2));
  const end = Math.min(totalPages, start + maxVisible - 1);
  start = Math.max(1, end - maxVisible + 1);

  const pages: number[] = [];
  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  const buildPageUrl = (p: number): string => {
    if (p === 1) return baseUrl;
    const separator = baseUrl.endsWith('/') ? '' : '/';
    return `${baseUrl}${separator}page/${p}/`;
  };

  return {
    currentPage: page,
    totalsExact: true,
    totalPages,
    totalItems,
    pageSize,
    hasPrev: page > 1,
    hasNext: page < totalPages,
    prevUrl: page > 1 ? buildPageUrl(page - 1) : null,
    nextUrl: page < totalPages ? buildPageUrl(page + 1) : null,
    pages,
  };
}

/**
 * Build pagination metadata from a pageSize + 1 query. Public archive pages
 * use this to avoid a costly count(*) scan merely to render numeric links.
 */
export function paginateLookahead(
  currentPage: number,
  pageSize: number,
  baseUrl: string,
  hasNext: boolean,
): PaginationInfo {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const page = Math.max(1, Math.floor(currentPage));

  const buildPageUrl = (targetPage: number): string => {
    if (targetPage === 1) return baseUrl;
    const separator = baseUrl.endsWith('/') ? '' : '/';
    return `${baseUrl}${separator}page/${targetPage}/`;
  };

  return {
    currentPage: page,
    totalsExact: false,
    totalPages: null,
    totalItems: null,
    pageSize: safePageSize,
    hasPrev: page > 1,
    hasNext,
    prevUrl: page > 1 ? buildPageUrl(page - 1) : null,
    nextUrl: hasNext ? buildPageUrl(page + 1) : null,
    pages: [],
  };
}
