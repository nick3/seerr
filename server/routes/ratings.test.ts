import Douban from '@server/api/rating/douban';
import TheMovieDb from '@server/api/themoviedb';
import {
  doubanCommentsHandler,
  doubanRatingHandler,
} from '@server/routes/ratings';
import type { ErrorRequestHandler } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const tmdbCalls: { type: string; options: unknown }[] = [];
for (const name of ['getMovie', 'getTvShow'] as const) {
  Object.defineProperty(TheMovieDb.prototype, name, {
    configurable: true,
    get: () => async (options: unknown) => {
      tmdbCalls.push({ type: name, options });
      return name === 'getMovie'
        ? {
            title: '肖申克的救赎',
            original_title: 'The Shawshank Redemption',
            release_date: '1994-09-23',
          }
        : {
            name: '魔女嘉莉',
            original_name: 'Carrie',
            first_air_date: '2026-10-07',
          };
    },
    set() {},
  });
}
after(() => {
  for (const name of ['getMovie', 'getTvShow'] as const) {
    Reflect.deleteProperty(TheMovieDb.prototype, name);
  }
});

const app = express();
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve('seerr-api.yml'),
    validateRequests: true,
    validateResponses: true,
    validateSecurity: false,
  })
);
app.get('/api/v1/movie/:id/ratings/douban', doubanRatingHandler('movie'));
app.get('/api/v1/tv/:id/ratings/douban', doubanRatingHandler('tv'));
app.get('/api/v1/movie/:id/comments/douban', doubanCommentsHandler('movie'));
app.get('/api/v1/tv/:id/comments/douban', doubanCommentsHandler('tv'));
// Express identifies error middleware by its four-argument signature.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.status(err.status ?? 500).json({ message: err.message });
};
app.use(errorHandler);

describe('Douban rating endpoints', () => {
  afterEach(() => {
    mock.restoreAll();
    tmdbCalls.length = 0;
  });

  for (const mediaType of ['movie', 'tv'] as const) {
    it(`returns a schema-valid ${mediaType} rating using Chinese and original titles`, async () => {
      const getRating = mock.method(
        Douban.prototype,
        'getRating',
        async () => ({
          id: '37083974',
          title: '魔女嘉莉',
          year: 2026,
          score: 7.8,
          url: 'https://movie.douban.com/subject/37083974/',
        })
      );
      const response = await request(app).get(
        `/api/v1/${mediaType}/288673/ratings/douban`
      );
      assert.equal(response.status, 200);
      assert.equal(response.body.rating.score, 7.8);
      assert.deepEqual(tmdbCalls[0], {
        type: mediaType === 'movie' ? 'getMovie' : 'getTvShow',
        options: {
          [mediaType === 'movie' ? 'movieId' : 'tvId']: 288673,
          language: 'zh-CN',
        },
      });
      assert.deepEqual(
        getRating.mock.calls[0].arguments[0],
        mediaType === 'movie'
          ? {
              mediaType,
              titles: ['肖申克的救赎', 'The Shawshank Redemption'],
              year: 1994,
            }
          : { mediaType, titles: ['魔女嘉莉', 'Carrie'], year: 2026 }
      );
    });
  }

  it('returns a successful empty lookup for a missing title', async () => {
    mock.method(Douban.prototype, 'getRating', async () => null);
    const response = await request(app).get('/api/v1/tv/288673/ratings/douban');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { rating: null });
  });

  it('allows an unrated subject without converting it to zero', async () => {
    mock.method(Douban.prototype, 'getRating', async () => ({
      id: '37083974',
      title: '魔女嘉莉',
      year: 2026,
      score: null,
      url: 'https://movie.douban.com/subject/37083974/',
    }));
    const response = await request(app).get('/api/v1/tv/288673/ratings/douban');
    assert.equal(response.status, 200);
    assert.equal(response.body.rating.score, null);
  });

  it('reports provider failures without exposing upstream errors', async () => {
    mock.method(Douban.prototype, 'getRating', async () => {
      throw new Error('upstream detail');
    });
    const response = await request(app).get('/api/v1/tv/288673/ratings/douban');
    assert.equal(response.status, 503);
    assert.equal(
      response.body.message,
      'Douban rating is temporarily unavailable.'
    );
  });

  it('rejects invalid identifiers before fetching metadata', async () => {
    for (const id of ['0', '-1', '1.5', 'invalid']) {
      const response = await request(app).get(
        `/api/v1/tv/${id}/ratings/douban`
      );
      assert.equal(response.status, 400);
    }
    assert.equal(tmdbCalls.length, 0);
  });
});

describe('Douban short review endpoints', () => {
  const subject = {
    id: '37083974',
    title: '魔女嘉莉',
    year: 2026,
    score: 7.8,
    url: 'https://movie.douban.com/subject/37083974/',
  };
  const reviews = {
    total: 42,
    comments: [
      {
        id: '123',
        author: '影迷',
        content: '一条短评',
        rating: 4,
        date: '2026-10-12',
        votes: 3,
      },
    ],
  };
  afterEach(() => {
    mock.restoreAll();
    tmdbCalls.length = 0;
  });

  for (const mediaType of ['movie', 'tv'] as const) {
    it(`returns schema-valid ${mediaType} reviews using the Douban ID, not the TMDB ID`, async () => {
      mock.method(Douban.prototype, 'getRating', async () => subject);
      const getComments = mock.method(
        Douban.prototype,
        'getComments',
        async () => reviews
      );
      const result = await request(app).get(
        `/api/v1/${mediaType}/288673/comments/douban`
      );
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        ...reviews,
        subject: { id: subject.id, title: subject.title, url: subject.url },
      });
      assert.deepEqual(getComments.mock.calls[0].arguments, [
        '37083974',
        'new_score',
      ]);
      assert.equal(
        tmdbCalls[0].type,
        mediaType === 'movie' ? 'getMovie' : 'getTvShow'
      );
    });
  }

  it('forwards the latest ordering', async () => {
    mock.method(Douban.prototype, 'getRating', async () => subject);
    const getComments = mock.method(
      Douban.prototype,
      'getComments',
      async () => reviews
    );
    const result = await request(app).get(
      '/api/v1/tv/288673/comments/douban?sort=time'
    );
    assert.equal(result.status, 200);
    assert.deepEqual(getComments.mock.calls[0].arguments, ['37083974', 'time']);
  });

  it('does not fetch reviews for an unmatched subject', async () => {
    mock.method(Douban.prototype, 'getRating', async () => null);
    const getComments = mock.method(
      Douban.prototype,
      'getComments',
      async () => reviews
    );
    const result = await request(app).get('/api/v1/tv/288673/comments/douban');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { subject: null, comments: [], total: 0 });
    assert.equal(getComments.mock.callCount(), 0);
  });

  it('shows reviews for a matched subject without an aggregate score', async () => {
    mock.method(Douban.prototype, 'getRating', async () => ({
      ...subject,
      score: null,
    }));
    mock.method(Douban.prototype, 'getComments', async () => reviews);
    const result = await request(app).get('/api/v1/tv/288673/comments/douban');
    assert.equal(result.status, 200);
    assert.equal(result.body.comments.length, 1);
  });

  it('allows empty lists and missing reviewer metadata in the response schema', async () => {
    mock.method(Douban.prototype, 'getRating', async () => subject);
    mock.method(Douban.prototype, 'getComments', async () => ({
      comments: [],
      total: 0,
    }));
    assert.equal(
      (await request(app).get('/api/v1/tv/288673/comments/douban')).status,
      200
    );
    mock.method(Douban.prototype, 'getComments', async () => ({
      total: 1,
      comments: [
        { ...reviews.comments[0], author: '', rating: null, date: null },
      ],
    }));
    const result = await request(app).get('/api/v1/tv/288673/comments/douban');
    assert.equal(result.status, 200);
    assert.equal(result.body.comments[0].rating, null);
  });

  it('isolates review failures from scores and does not expose upstream details', async () => {
    mock.method(Douban.prototype, 'getRating', async () => subject);
    mock.method(Douban.prototype, 'getComments', async () => {
      throw new Error('upstream detail');
    });
    const result = await request(app).get('/api/v1/tv/288673/comments/douban');
    assert.equal(result.status, 503);
    assert.equal(
      result.body.message,
      'Douban comments are temporarily unavailable.'
    );
    assert.equal(
      (await request(app).get('/api/v1/tv/288673/ratings/douban')).body.rating
        .score,
      7.8
    );
  });

  it('rejects invalid IDs and sort queries before fetching metadata', async () => {
    for (const suffix of [
      '0/comments/douban',
      'invalid/comments/douban',
      '1/comments/douban?sort=bad',
      '1/comments/douban?sort=time&sort=new_score',
    ]) {
      const result = await request(app).get(`/api/v1/tv/${suffix}`);
      assert.equal(result.status, 400);
    }
    assert.equal(tmdbCalls.length, 0);
  });
});
