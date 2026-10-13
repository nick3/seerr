import Douban from '@server/api/rating/douban';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import type { DoubanBindingSource } from '@server/entity/DoubanBinding';
import DoubanBinding from '@server/entity/DoubanBinding';
import logger from '@server/logger';

type MediaType = 'movie' | 'tv';
const pending = new Map<string, Promise<unknown>>();

// Serialize resolution and edits per title, without holding a DB transaction
// during network calls. In-flight automatic matches cannot undo a manual edit.
async function serialized<T>(
  mediaType: MediaType,
  tmdbId: number,
  action: () => Promise<T>
): Promise<T> {
  const key = `${mediaType}:${tmdbId}`;
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}

export const getDoubanBinding = (mediaType: MediaType, tmdbId: number) =>
  getRepository(DoubanBinding).findOneBy({ mediaType, tmdbId });

export const resolveDoubanRating = (mediaType: MediaType, tmdbId: number) =>
  serialized(mediaType, tmdbId, async () => {
    const douban = new Douban();
    const saved = await getDoubanBinding(mediaType, tmdbId);
    if (saved) return douban.getSubject(saved.doubanId, mediaType);

    const tmdb = new TheMovieDb();
    const media =
      mediaType === 'movie'
        ? await tmdb.getMovie({ movieId: tmdbId, language: 'zh-CN' })
        : await tmdb.getTvShow({ tvId: tmdbId, language: 'zh-CN' });
    const titles =
      'title' in media
        ? [media.title, media.original_title]
        : [media.name, media.original_name];
    const date =
      'release_date' in media ? media.release_date : media.first_air_date;
    const year = date ? Number(date.slice(0, 4)) : undefined;
    const imdbId = media.external_ids?.imdb_id;
    let source: DoubanBindingSource = 'imdb';
    let imdbFailed = false;
    const imdbRating = imdbId
      ? await douban.getRatingByImdb({ imdbId, mediaType, year }).catch(() => {
          imdbFailed = true;
          logger.debug('Douban IMDb search unavailable; trying titles', {
            label: 'Douban',
            mediaType,
            tmdbId,
          });
          return null;
        })
      : null;
    let rating = imdbRating;
    if (!rating) {
      source = 'title';
      rating = await douban.getRating({ mediaType, titles, year });
    }
    if (!rating) {
      if (imdbFailed) throw new Error('Douban IMDb search unavailable');
      return null;
    }
    // The unique key also protects manual bindings from other server processes.
    await getRepository(DoubanBinding)
      .createQueryBuilder()
      .insert()
      .values({ mediaType, tmdbId, doubanId: rating.id, source })
      .orIgnore()
      .execute();
    const winner = await getDoubanBinding(mediaType, tmdbId);
    return winner && winner.doubanId !== rating.id
      ? douban.getSubject(winner.doubanId, mediaType)
      : rating;
  });

export const saveDoubanBinding = (
  mediaType: MediaType,
  tmdbId: number,
  doubanId: string
) =>
  serialized(mediaType, tmdbId, async () => {
    const rating = await new Douban().getSubject(doubanId, mediaType);
    if (!rating) return null;
    await getRepository(DoubanBinding).upsert(
      { mediaType, tmdbId, doubanId, source: 'manual' },
      ['mediaType', 'tmdbId']
    );
    return rating;
  });

export const resetDoubanBinding = (mediaType: MediaType, tmdbId: number) =>
  serialized(mediaType, tmdbId, async () => {
    await getRepository(DoubanBinding).delete({ mediaType, tmdbId });
  });
