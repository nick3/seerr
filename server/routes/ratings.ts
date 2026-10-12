import Douban from '@server/api/rating/douban';
import TheMovieDb from '@server/api/themoviedb';
import logger from '@server/logger';
import type { RequestHandler } from 'express';

const getDoubanSubject = async (mediaType: 'movie' | 'tv', tmdbId: number) => {
  const tmdb = new TheMovieDb();
  // A Chinese title improves matching regardless of the viewer's locale.
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
  return new Douban().getRating({
    mediaType,
    titles,
    year: date ? Number(date.slice(0, 4)) : undefined,
  });
};

export const doubanRatingHandler =
  (mediaType: 'movie' | 'tv'): RequestHandler =>
  async (req, res, next) => {
    const tmdbId = Number(req.params.id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
      return next({ status: 400, message: 'Invalid TMDB ID.' });
    }

    try {
      const rating = await getDoubanSubject(mediaType, tmdbId);
      return res.status(200).json({ rating });
    } catch (e) {
      logger.debug('Unable to retrieve Douban rating', {
        label: 'API',
        errorMessage: e.message,
        mediaType,
        tmdbId,
      });
      return next({
        status: 503,
        message: 'Douban rating is temporarily unavailable.',
      });
    }
  };

export const doubanCommentsHandler =
  (mediaType: 'movie' | 'tv'): RequestHandler =>
  async (req, res, next) => {
    const tmdbId = Number(req.params.id);
    const sort = req.query.sort ?? 'new_score';
    if (
      !Number.isSafeInteger(tmdbId) ||
      tmdbId <= 0 ||
      (sort !== 'new_score' && sort !== 'time')
    ) {
      return next({ status: 400, message: 'Invalid Douban comments request.' });
    }

    try {
      const subject = await getDoubanSubject(mediaType, tmdbId);
      if (!subject) return res.json({ subject: null, comments: [], total: 0 });
      const result = await new Douban().getComments(subject.id, sort);
      return res.json({
        subject: { id: subject.id, title: subject.title, url: subject.url },
        ...result,
      });
    } catch (e) {
      logger.debug('Unable to retrieve Douban comments', {
        label: 'API',
        errorMessage: e.message,
        mediaType,
        tmdbId,
      });
      return next({
        status: 503,
        message: 'Douban comments are temporarily unavailable.',
      });
    }
  };
