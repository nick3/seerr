import Douban from '@server/api/rating/douban';
import {
  getDoubanBinding,
  resetDoubanBinding,
  resolveDoubanRating,
  saveDoubanBinding,
} from '@server/lib/douban';
import logger from '@server/logger';
import type { RequestHandler } from 'express';

export const doubanRatingHandler =
  (mediaType: 'movie' | 'tv'): RequestHandler =>
  async (req, res, next) => {
    const tmdbId = Number(req.params.id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
      return next({ status: 400, message: 'Invalid TMDB ID.' });
    }

    try {
      const rating = await resolveDoubanRating(mediaType, tmdbId);
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
      const subject = await resolveDoubanRating(mediaType, tmdbId);
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

export const doubanBindingHandler =
  (mediaType: 'movie' | 'tv'): RequestHandler =>
  async (req, res, next) => {
    const tmdbId = Number(req.params.id);
    const doubanId =
      req.method === 'PUT' ? req.body?.doubanId : req.query.doubanId;
    if (
      !Number.isSafeInteger(tmdbId) ||
      tmdbId <= 0 ||
      ((req.method === 'PUT' || req.path.endsWith('/preview')) &&
        (typeof doubanId !== 'string' || !/^[1-9]\d{0,11}$/.test(doubanId)))
    ) {
      return next({ status: 400, message: 'Invalid Douban binding request.' });
    }
    try {
      if (req.method === 'DELETE') {
        await resetDoubanBinding(mediaType, tmdbId);
        return res.sendStatus(204);
      }
      if (req.method === 'PUT' || req.path.endsWith('/preview')) {
        const rating =
          req.method === 'PUT'
            ? await saveDoubanBinding(mediaType, tmdbId, doubanId as string)
            : await new Douban().getSubject(doubanId as string, mediaType);
        if (!rating)
          return next({
            status: 400,
            message: 'Douban subject does not match the media type.',
          });
        return res.json({ rating });
      }
      const binding = await getDoubanBinding(mediaType, tmdbId);
      return res.json({
        binding: binding
          ? { doubanId: binding.doubanId, source: binding.source }
          : null,
      });
    } catch (e) {
      logger.debug('Unable to update Douban binding', {
        label: 'Douban',
        mediaType,
        tmdbId,
        errorMessage: e.message,
      });
      return next({
        status: 503,
        message: 'Douban binding is temporarily unavailable.',
      });
    }
  };
