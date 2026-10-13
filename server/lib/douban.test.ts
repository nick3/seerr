import Douban from '@server/api/rating/douban';
import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import DoubanBinding from '@server/entity/DoubanBinding';
import cacheManager from '@server/lib/cache';
import {
  getDoubanBinding,
  resetDoubanBinding,
  resolveDoubanRating,
  saveDoubanBinding,
} from '@server/lib/douban';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { after, afterEach, describe, it, mock } from 'node:test';

setupTestDb();
let tmdbCalls = 0;
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  configurable: true,
  get: () => async () => {
    tmdbCalls++;
    return {
      name: '哆啦A梦',
      original_name: 'ドラえもん',
      first_air_date: '2005-04-22',
      external_ids: { imdb_id: 'tt4083422' },
    };
  },
  set() {},
});
after(() => Reflect.deleteProperty(TheMovieDb.prototype, 'getTvShow'));
const rating = {
  id: '3538051',
  title: '哆啦A梦',
  year: 2005,
  score: 9.6,
  url: 'https://movie.douban.com/subject/3538051/',
};
const other = { ...rating, id: '999' };

describe('Persistent Douban matching', () => {
  afterEach(() => {
    mock.restoreAll();
    tmdbCalls = 0;
    cacheManager.getCache('douban').flush();
  });

  it('saves an IMDb match before title fallback and reads it after caches are cleared', async () => {
    const imdb = mock.method(
      Douban.prototype,
      'getRatingByImdb',
      async () => rating
    );
    const names = mock.method(Douban.prototype, 'getRating', async () => null);
    mock.method(Douban.prototype, 'getSubject', async () => rating);
    assert.deepEqual(await resolveDoubanRating('tv', 65733), rating);
    assert.deepEqual(imdb.mock.calls[0].arguments[0], {
      mediaType: 'tv',
      imdbId: 'tt4083422',
      year: 2005,
    });
    assert.equal((await getDoubanBinding('tv', 65733))?.source, 'imdb');
    cacheManager.getCache('douban').flush();
    assert.deepEqual(await resolveDoubanRating('tv', 65733), rating);
    assert.equal(tmdbCalls, 1);
    assert.equal(imdb.mock.callCount(), 1);
    assert.equal(names.mock.callCount(), 0);
  });

  it('uses a manual binding before TMDB or searches, even when metadata is unavailable', async () => {
    mock.method(Douban.prototype, 'getSubject', async () => rating);
    await saveDoubanBinding('tv', 65733, rating.id);
    assert.deepEqual(await resolveDoubanRating('tv', 65733), rating);
    assert.equal(tmdbCalls, 0);
    assert.equal((await getDoubanBinding('tv', 65733))?.source, 'manual');
  });

  for (const failure of [false, true]) {
    it(`falls back to names and saves the binding when IMDb ${failure ? 'fails' : 'misses'}`, async () => {
      mock.method(Douban.prototype, 'getRatingByImdb', async () => {
        if (failure) throw new Error('unavailable');
        return null;
      });
      mock.method(Douban.prototype, 'getRating', async () => rating);
      assert.equal((await resolveDoubanRating('tv', 65733))?.id, rating.id);
      assert.equal((await getDoubanBinding('tv', 65733))?.source, 'title');
    });
  }

  it('does not persist misses or treat an IMDb outage as a definitive miss', async () => {
    const imdb = mock.method(
      Douban.prototype,
      'getRatingByImdb',
      async () => null
    );
    mock.method(Douban.prototype, 'getRating', async () => null);
    assert.equal(await resolveDoubanRating('tv', 65733), null);
    imdb.mock.mockImplementation(async () => {
      throw new Error('down');
    });
    await assert.rejects(resolveDoubanRating('tv', 65733));
    assert.equal(await getRepository(DoubanBinding).count(), 0);
  });

  it('preserves a binding across provider outages and resets it explicitly', async () => {
    const subject = mock.method(
      Douban.prototype,
      'getSubject',
      async () => rating
    );
    await saveDoubanBinding('tv', 65733, rating.id);
    subject.mock.mockImplementation(async () => {
      throw new Error('down');
    });
    await assert.rejects(resolveDoubanRating('tv', 65733));
    assert.equal((await getDoubanBinding('tv', 65733))?.doubanId, rating.id);
    await resetDoubanBinding('tv', 65733);
    assert.equal(await getDoubanBinding('tv', 65733), null);
    mock.method(Douban.prototype, 'getRatingByImdb', async () => other);
    assert.equal((await resolveDoubanRating('tv', 65733))?.id, other.id);
  });

  it('serializes simultaneous ratings/reviews and manual edits without overwriting the manual choice', async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const imdb = mock.method(Douban.prototype, 'getRatingByImdb', async () => {
      started();
      await wait;
      return rating;
    });
    mock.method(Douban.prototype, 'getSubject', async (id: string) =>
      id === other.id ? other : rating
    );
    const first = resolveDoubanRating('tv', 65733);
    await start;
    const second = resolveDoubanRating('tv', 65733);
    const edit = saveDoubanBinding('tv', 65733, other.id);
    release();
    await Promise.all([first, second, edit]);
    assert.equal(imdb.mock.callCount(), 1);
    assert.equal((await resolveDoubanRating('tv', 65733))?.id, other.id);
    assert.equal((await getDoubanBinding('tv', 65733))?.source, 'manual');
    assert.equal(await getRepository(DoubanBinding).count(), 1);
  });

  it('rejects an incompatible manual subject without changing the saved binding', async () => {
    const subject = mock.method(
      Douban.prototype,
      'getSubject',
      async () => rating
    );
    await saveDoubanBinding('tv', 65733, rating.id);
    subject.mock.mockImplementation(async () => null);
    assert.equal(await saveDoubanBinding('tv', 65733, other.id), null);
    assert.equal((await getDoubanBinding('tv', 65733))?.doubanId, rating.id);
  });
});
