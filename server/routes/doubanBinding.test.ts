import Douban from '@server/api/rating/douban';
import { getRepository } from '@server/datasource';
import DoubanBinding from '@server/entity/DoubanBinding';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import movieRoutes from '@server/routes/movie';
import tvRoutes from '@server/routes/tv';
import { setupTestDb } from '@server/test/db';
import type { ErrorRequestHandler } from 'express';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

setupTestDb();
const app = express();
app.use(express.json());
app.use(checkUser);
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve('seerr-api.yml'),
    validateRequests: true,
    validateResponses: true,
    validateSecurity: false,
  })
);
app.use('/api/v1/movie', isAuthenticated(), movieRoutes);
app.use('/api/v1/tv', isAuthenticated(), tvRoutes);
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) =>
  res.status(err.status ?? 500).json({ message: err.message });
app.use(errorHandler);
const rating = {
  id: '3538051',
  title: '哆啦A梦',
  year: 2005,
  score: 9.6,
  url: 'https://movie.douban.com/subject/3538051/',
};
const auth = () => ({ 'X-API-Key': getSettings().main.apiKey });

describe('Douban binding endpoints and permissions', () => {
  afterEach(() => mock.restoreAll());
  for (const media of ['movie', 'tv']) {
    it(`previews, saves, reads, and resets a schema-valid ${media} binding`, async () => {
      mock.method(Douban.prototype, 'getSubject', async () => rating);
      const base = `/api/v1/${media}/65733/douban`;
      assert.equal(
        (await request(app).get(`${base}/preview?doubanId=3538051`).set(auth()))
          .status,
        200
      );
      assert.equal(await getRepository(DoubanBinding).count(), 0);
      assert.equal(
        (await request(app).put(base).set(auth()).send({ doubanId: rating.id }))
          .status,
        200
      );
      const saved = await request(app).get(base).set(auth());
      assert.deepEqual(saved.body, {
        binding: { doubanId: rating.id, source: 'manual' },
      });
      const score = await request(app)
        .get(`/api/v1/${media}/65733/ratings/douban`)
        .set(auth());
      assert.equal(score.body.rating.id, rating.id);
      assert.equal((await request(app).delete(base).set(auth())).status, 204);
      assert.equal(await getRepository(DoubanBinding).count(), 0);
    });

    it(`denies anonymous and ordinary users access to ${media} binding operations`, async () => {
      const get = mock.method(
        Douban.prototype,
        'getSubject',
        async () => rating
      );
      for (const headers of [{}, { ...auth(), 'X-API-User': '2' }]) {
        const base = `/api/v1/${media}/65733/douban`;
        assert.equal((await request(app).get(base).set(headers)).status, 403);
        assert.equal(
          (
            await request(app)
              .get(`${base}/preview?doubanId=3538051`)
              .set(headers)
          ).status,
          403
        );
        assert.equal(
          (
            await request(app)
              .put(base)
              .set(headers)
              .send({ doubanId: rating.id })
          ).status,
          403
        );
        assert.equal(
          (await request(app).delete(base).set(headers)).status,
          403
        );
      }
      assert.equal(get.mock.callCount(), 0);
    });
  }

  it('rejects URLs, paths, overlong IDs, and malformed payloads before contacting Douban', async () => {
    const get = mock.method(Douban.prototype, 'getSubject', async () => rating);
    for (const doubanId of [
      '../admin',
      'https://movie.douban.com/subject/3538051/',
      '0',
      '1'.repeat(13),
      3538051,
      null,
    ]) {
      assert.equal(
        (
          await request(app)
            .put('/api/v1/tv/65733/douban')
            .set(auth())
            .send({ doubanId })
        ).status,
        400
      );
    }
    assert.equal(get.mock.callCount(), 0);
  });

  it('rejects mismatched media and keeps provider failures generic', async () => {
    const get = mock.method(Douban.prototype, 'getSubject', async () => null);
    assert.equal(
      (
        await request(app)
          .put('/api/v1/tv/65733/douban')
          .set(auth())
          .send({ doubanId: rating.id })
      ).status,
      400
    );
    get.mock.mockImplementation(async () => {
      throw new Error('private upstream details');
    });
    const response = await request(app)
      .put('/api/v1/tv/65733/douban')
      .set(auth())
      .send({ doubanId: rating.id });
    assert.equal(response.status, 503);
    assert.ok(!response.text.includes('private'));
    assert.equal(await getRepository(DoubanBinding).count(), 0);
  });
});
