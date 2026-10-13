import Douban from '@server/api/rating/douban';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const lookup = { imdbId: 'tt4083422', mediaType: 'tv' as const, year: 2005 };
const subject = {
  id: '3538051',
  title: '哆啦A梦 ドラえもん (2005)',
  release_year: '2005',
  is_tv: true,
  rate: '9.6',
};
const link = (id: string, query = lookup.imdbId) =>
  `<a href="https://www.douban.com/link2/?url=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F${id}%2F&amp;query=${query}&amp;cat_id=1002&amp;type=search">Title</a>`;
const page = (links: string) =>
  `<div class="search-result"><div class="result-list">${links}</div></div>`;

describe('Douban IMDb lookup', () => {
  beforeEach(() => cacheManager.getCache('douban').flush());
  afterEach(() => mock.restoreAll());

  function stub(html = page(link(subject.id)), data = subject) {
    const api = new Douban();
    const get = mock.method(
      (api as unknown as { axios: AxiosInstance }).axios,
      'get',
      async (path: string, config: AxiosRequestConfig) => {
        if (path === 'https://www.douban.com/search') {
          assert.deepEqual(config.params, { cat: '1002', q: lookup.imdbId });
          assert.equal(config.maxRedirects, 0);
          return { data: html };
        }
        assert.equal(path, '/j/subject_abstract');
        assert.equal(config.params.subject_id, data.id);
        return { data: { r: 0, subject: data } };
      }
    );
    return { api, get };
  }

  it('finds the 2005 series by IMDb, deduplicates links, and caches the result', async () => {
    const { api, get } = stub(page(link(subject.id) + link(subject.id)));
    const results = await Promise.all([
      api.getRatingByImdb(lookup),
      api.getRatingByImdb(lookup),
    ]);
    assert.equal(results[0]?.id, '3538051');
    assert.equal(results[1]?.score, 9.6);
    await api.getRatingByImdb(lookup);
    assert.equal(get.mock.callCount(), 2);
  });

  it('accepts a genuine empty search, but never caches a login or challenge page', async () => {
    const { api, get } = stub('<html>login or captcha</html>');
    await assert.rejects(api.getRatingByImdb(lookup));
    await assert.rejects(api.getRatingByImdb(lookup));
    assert.equal(get.mock.callCount(), 2);
    get.mock.mockImplementation(async () => ({
      data: '<div class="search-result"><p class="no-result">No results</p></div>',
    }));
    assert.equal(await api.getRatingByImdb(lookup), null);
  });

  it('ignores links for different queries, external URLs, and unrelated recommendations', async () => {
    const { api, get } = stub(
      page(
        link(subject.id) +
          link('123', 'tt0111161') +
          '<a href="http://127.0.0.1/subject/123/">bad</a>'
      )
    );
    assert.equal((await api.getRatingByImdb(lookup))?.id, subject.id);
    assert.equal(get.mock.callCount(), 2);
  });

  for (const data of [
    { ...subject, release_year: '1979' },
    { ...subject, is_tv: false },
  ]) {
    it(`rejects the wrong year or media type: ${JSON.stringify(data)}`, async () => {
      assert.equal(
        await stub(undefined, data).api.getRatingByImdb(lookup),
        null
      );
    });
  }

  it('does not select the first of several compatible subjects', async () => {
    const { api } = stub(page(link('3538051') + link('1782004')));
    mock.method(api, 'getSubject', async (id: string) => ({
      id,
      title: 'Title',
      year: 2005,
      score: 9,
      url: `https://movie.douban.com/subject/${id}/`,
    }));
    assert.equal(await api.getRatingByImdb(lookup), null);
  });

  it('bounds ambiguous fanout and ignores invalid IMDb IDs without requests', async () => {
    const { api, get } = stub(
      page(['1', '2', '3', '4'].map((id) => link(id)).join(''))
    );
    assert.equal(await api.getRatingByImdb(lookup), null);
    assert.equal(get.mock.callCount(), 1);
    assert.equal(
      await api.getRatingByImdb({ ...lookup, imdbId: 'https://example.com' }),
      null
    );
    assert.equal(
      await api.getRatingByImdb({ ...lookup, year: undefined }),
      null
    );
    assert.equal(get.mock.callCount(), 1);
  });
});
