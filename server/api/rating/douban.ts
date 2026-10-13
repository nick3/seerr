import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import { z } from 'zod';

const RATING_TTL = 21600;
const NO_RATING_TTL = 900;
const COMMENTS_TTL = 300;
const COMMENTS_LIMIT = 6;

const commentSchema = z.object({
  id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
  content: z.string().trim().min(1).max(10000),
  user: z.object({ name: z.string().trim().max(200).catch('') }).nullish(),
  rating: z.union([z.string(), z.number()]).nullish(),
  votes: z.coerce.number().int().nonnegative().catch(0),
  time: z.string().optional(),
});

const commentsSchema = z.object({
  retcode: z.literal(1),
  result: z.object({
    normal: z.array(z.unknown()),
    total_num: z.coerce.number().int().nonnegative(),
  }),
});

export type DoubanCommentSort = 'new_score' | 'time';

export interface DoubanComment {
  id: string;
  author: string;
  content: string;
  rating: number | null;
  votes: number;
  date: string | null;
}

export interface DoubanComments {
  comments: DoubanComment[];
  total: number;
}

const suggestionSchema = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string(),
  sub_title: z.string().optional(),
  year: z.string(),
});

const abstractSchema = z.object({
  r: z.literal(0),
  subject: z.object({
    id: z.string(),
    title: z.string(),
    release_year: z.string(),
    is_tv: z.boolean(),
    rate: z.union([z.string(), z.number()]).nullish(),
  }),
});

export interface DoubanRating {
  id: string;
  title: string;
  year: number;
  score: number | null;
  url: string;
}

interface RatingOptions {
  mediaType: 'movie' | 'tv';
  titles: string[];
  year?: number;
}

// TMDB describes a series as a whole; Douban generally rates each season.
// Only the first season is an acceptable match for a series-level rating.
const normalizeTitle = (
  title: string,
  mediaType: RatingOptions['mediaType']
) => {
  const normalized = title.normalize('NFKC').toLowerCase().trim();
  return (
    mediaType === 'tv'
      ? normalized.replace(/\s*(?:第\s*(?:一|0?1)\s*季|season\s+0?1)$/u, '')
      : normalized
  ).replace(/[^\p{L}\p{N}]/gu, '');
};

const pendingRatings = new Map<string, Promise<DoubanRating | null>>();
const pendingComments = new Map<string, Promise<DoubanComments>>();

/**
 * Best-effort access to Douban's public website APIs. Suggestions identify
 * candidates; subject_abstract supplies the score and the actual media type
 * (subject_suggest labels both movies and TV series as "movie").
 */
class Douban extends ExternalAPI {
  constructor() {
    super(
      'https://movie.douban.com',
      {},
      {
        // These bodyless GET endpoints reject Content-Type: application/json.
        headers: {
          'Content-Type': undefined,
          Referer: 'https://movie.douban.com/',
        },
        timeout: 5000,
      }
    );
  }

  public async getRating(options: RatingOptions): Promise<DoubanRating | null> {
    const titles = [
      ...new Set(options.titles.filter(Boolean).map((t) => t.trim())),
    ]
      .filter(Boolean)
      .slice(0, 2);
    if (!titles.length || !options.year || !Number.isInteger(options.year)) {
      return null;
    }

    const lookup = { ...options, titles, year: options.year };
    const cache = cacheManager.getCache('douban').data;
    const key = JSON.stringify(lookup);
    const cached = cache.get<{ rating: DoubanRating | null }>(key);
    if (cached) return cached.rating;

    const pending = pendingRatings.get(key);
    if (pending) return pending;

    const request = this.findRating(lookup)
      .then((rating) => {
        cache.set(key, { rating }, rating?.score ? RATING_TTL : NO_RATING_TTL);
        return rating;
      })
      .finally(() => pendingRatings.delete(key));
    pendingRatings.set(key, request);
    return request;
  }

  /** Read a known subject without relying on names or search availability. */
  public async getSubject(
    subjectId: string,
    mediaType: 'movie' | 'tv',
    year?: number
  ): Promise<DoubanRating | null> {
    if (!/^[1-9]\d{0,11}$/.test(subjectId)) {
      throw new Error('Invalid Douban subject ID');
    }
    const subject = await this.get<unknown>(
      '/j/subject_abstract',
      {
        params: { subject_id: subjectId },
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
      },
      NO_RATING_TTL,
      {
        cache: cacheManager.getCache('douban').data,
        transform: (data) => {
          const parsed = abstractSchema.safeParse(data);
          if (!parsed.success || parsed.data.subject.id !== subjectId) {
            throw new Error('Invalid Douban subject response');
          }
          return data;
        },
      }
    );
    const data = abstractSchema.parse(subject).subject;
    const releaseYear = Number(data.release_year);
    if (
      data.is_tv !== (mediaType === 'tv') ||
      !Number.isInteger(releaseYear) ||
      releaseYear < 1870 ||
      (year !== undefined && releaseYear !== year)
    )
      return null;
    const score = Number(data.rate);
    return {
      id: data.id,
      title: data.title,
      year: releaseYear,
      score: Number.isFinite(score) && score > 0 && score <= 10 ? score : null,
      url: `https://movie.douban.com/subject/${data.id}/`,
    };
  }

  public async getRatingByImdb({
    imdbId,
    mediaType,
    year,
  }: {
    imdbId: string;
    mediaType: 'movie' | 'tv';
    year?: number;
  }): Promise<DoubanRating | null> {
    if (!/^tt\d{7,12}$/.test(imdbId) || !year || !Number.isInteger(year))
      return null;
    const cache = cacheManager.getCache('douban').data;
    const key = `imdb:${mediaType}:${imdbId}:${year}`;
    const cached = cache.get<{ rating: DoubanRating | null }>(key);
    if (cached) return cached.rating;
    const pending = pendingRatings.get(key);
    if (pending) return pending;
    const request = (async () => {
      // subject_suggest does not accept IMDb IDs; Douban's website search does.
      const html = await this.get<string>('https://www.douban.com/search', {
        params: { cat: '1002', q: imdbId },
        headers: { Accept: 'text/html', Referer: 'https://www.douban.com/' },
        responseType: 'text',
        maxRedirects: 0,
        maxContentLength: 1024 * 1024,
      });
      if (
        typeof html !== 'string' ||
        !/class=["']search-result["']/.test(html) ||
        !/class=["'](?:result-list|no-result)["']/.test(html)
      ) {
        throw new Error('Invalid Douban IMDb search response');
      }
      const ids = new Set<string>();
      // Only accept search links tied to this exact query/category. Never fetch
      // URLs supplied by the page, including redirects and recommended titles.
      for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
        try {
          const link = new URL(match[1].replace(/&amp;/g, '&'));
          if (
            link.origin !== 'https://www.douban.com' ||
            link.pathname !== '/link2/' ||
            link.searchParams.get('query') !== imdbId ||
            link.searchParams.get('cat_id') !== '1002' ||
            link.searchParams.get('type') !== 'search'
          )
            continue;
          const target = new URL(link.searchParams.get('url') ?? '');
          const id = target.pathname.match(
            /^\/subject\/([1-9]\d{0,11})\/?$/
          )?.[1];
          if (target.origin === 'https://movie.douban.com' && id) ids.add(id);
        } catch {
          /* Ignore malformed links, not provider errors. */
        }
      }
      if (/class=["']result-list["']/.test(html) && !ids.size) {
        throw new Error('Unrecognized Douban IMDb search results');
      }
      const matches =
        ids.size <= 3
          ? (
              await Promise.all(
                [...ids].map((id) => this.getSubject(id, mediaType, year))
              )
            ).filter((rating) => rating !== null)
          : [];
      const rating = matches.length === 1 ? matches[0] : null;
      cache.set(key, { rating }, rating?.score ? RATING_TTL : NO_RATING_TTL);
      return rating;
    })().finally(() => pendingRatings.delete(key));
    pendingRatings.set(key, request);
    return request;
  }

  public async getComments(
    subjectId: string,
    sort: DoubanCommentSort = 'new_score'
  ): Promise<DoubanComments> {
    if (!/^\d+$/.test(subjectId) || !['new_score', 'time'].includes(sort)) {
      throw new Error('Invalid Douban comments lookup');
    }

    const cache = cacheManager.getCache('douban').data;
    const key = `comments:${subjectId}:${sort}`;
    const cached = cache.get<DoubanComments>(key);
    if (cached) return cached;
    const pending = pendingComments.get(key);
    if (pending) return pending;

    // Public JSON endpoint documented at https://www.worldbook.it.com/webmcp/douban.
    // Keep comments independent of the rating lookup so failures cannot hide scores.
    const request = this.get<unknown>(`/j/subject/${subjectId}/comments`, {
      params: { start: 0, limit: COMMENTS_LIMIT, status: 'P', sort },
      maxRedirects: 0,
      maxContentLength: 1024 * 1024,
    })
      .then((data) => {
        const response = commentsSchema.safeParse(data);
        if (!response.success)
          throw new Error('Invalid Douban comments response');

        const comments = new Map<string, DoubanComment>();
        // Only normal comments are returned; never include the provider's spam list.
        for (const item of response.data.result.normal) {
          const parsed = commentSchema.safeParse(item);
          if (!parsed.success) continue;
          const comment = parsed.data;
          const rating = Number(comment.rating);
          const date = comment.time?.match(/^(\d{4}-\d{2}-\d{2})(?:\s|$)/)?.[1];
          comments.set(String(comment.id), {
            id: String(comment.id),
            author: comment.user?.name ?? '',
            content: comment.content,
            rating:
              Number.isInteger(rating) && rating >= 1 && rating <= 5
                ? rating
                : null,
            votes: comment.votes,
            date:
              date &&
              !Number.isNaN(Date.parse(date)) &&
              new Date(date).toISOString().startsWith(date)
                ? date
                : null,
          });
          if (comments.size === COMMENTS_LIMIT) break;
        }

        if (response.data.result.normal.length && !comments.size) {
          throw new Error('Invalid Douban comments response');
        }
        const result = {
          comments: [...comments.values()],
          total: response.data.result.total_num,
        };
        cache.set(key, result, COMMENTS_TTL);
        return result;
      })
      .finally(() => pendingComments.delete(key));
    pendingComments.set(key, request);
    return request;
  }

  private async findRating({
    mediaType,
    titles,
    year,
  }: RatingOptions & { year: number }): Promise<DoubanRating | null> {
    const names = new Set(
      titles.map((title) => normalizeTitle(title, mediaType))
    );
    // Douban's suggestions can differ by case/character width (for example,
    // 哆啦A梦 omits the 2005 series, while 哆啦a梦 includes it). Retry only on
    // a miss, keeping successful original-title lookups fast and unchanged.
    const normalizedQueries = [
      ...new Set(
        titles.map((title) => title.normalize('NFKC').toLowerCase().trim())
      ),
    ].filter((query) => query && !titles.includes(query));
    const candidates = new Map<string, z.infer<typeof suggestionSchema>>();
    for (const queries of [titles, normalizedQueries]) {
      const results = await Promise.all(
        queries.map((q) =>
          this.get<unknown>('/j/subject_suggest', {
            params: { q },
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
          })
        )
      );
      for (const result of results) {
        if (!Array.isArray(result)) {
          throw new Error('Invalid Douban search response');
        }
        for (const item of result) {
          const parsed = suggestionSchema.safeParse(item);
          if (!parsed.success) continue;
          const candidate = parsed.data;
          if (
            candidate.year === String(year) &&
            [candidate.title, candidate.sub_title].some(
              (title) => title && names.has(normalizeTitle(title, mediaType))
            )
          ) {
            candidates.set(candidate.id, candidate);
          }
        }
      }
      if (candidates.size) break;
    }

    // Never choose the first search hit or fan out over an ambiguous result set.
    if (!candidates.size || candidates.size > 3) return null;

    const matches = await Promise.all(
      [...candidates.keys()].map((id) => this.getSubject(id, mediaType, year))
    );

    const ratings = matches.filter((rating) => rating !== null);
    return ratings.length === 1 ? ratings[0] : null;
  }
}

export default Douban;
