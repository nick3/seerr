import Douban from '@server/api/rating/douban';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const suggestion = {
  id: '37083974',
  title: '魔女嘉莉',
  sub_title: 'Carrie',
  year: '2026',
  type: 'movie', // Douban also returns "movie" for TV suggestions.
};
const subject = {
  id: suggestion.id,
  title: '魔女嘉莉 Carrie (2026)',
  release_year: '2026',
  is_tv: true,
  rate: '7.8',
};
const lookup = {
  mediaType: 'tv' as const,
  titles: ['魔女嘉莉', 'Carrie'],
  year: 2026,
};

function stub(
  api: Douban,
  suggestions: unknown = [suggestion],
  abstract: unknown = { r: 0, subject }
) {
  const axios = (api as unknown as { axios: AxiosInstance }).axios;
  return mock.method(axios, 'get', async (path: string) => ({
    data: path === '/j/subject_suggest' ? suggestions : abstract,
  }));
}

describe('Douban ratings', () => {
  beforeEach(() => cacheManager.getCache('douban').flush());
  afterEach(() => mock.restoreAll());

  it('sends encoded GET queries without the Content-Type header Douban rejects', async (t) => {
    const requests: { path: string; contentType: string | undefined }[] = [];
    const server = createServer((req, res) => {
      requests.push({
        path: req.url ?? '',
        contentType: req.headers['content-type'],
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url?.startsWith('/j/subject_suggest')
            ? [suggestion]
            : { r: 0, subject }
        )
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve()))
    );
    const api = new Douban();
    (api as unknown as { axios: AxiosInstance }).axios.defaults.baseURL =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    assert.equal((await api.getRating(lookup))?.score, 7.8);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((req) => req.contentType === undefined));
    const queries = requests.map(
      (req) => new URL(req.path, 'http://localhost').searchParams
    );
    assert.ok(queries.some((params) => params.get('q') === '魔女嘉莉'));
    assert.ok(
      queries.some((params) => params.get('subject_id') === '37083974')
    );
  });

  it('matches a TV show and reads the real score from its abstract', async () => {
    const api = new Douban();
    const get = stub(api);
    const rating = await api.getRating(lookup);
    assert.deepEqual(rating, {
      id: '37083974',
      title: subject.title,
      year: 2026,
      score: 7.8,
      url: 'https://movie.douban.com/subject/37083974/',
    });
    assert.equal(get.mock.callCount(), 3);
    const detail = get.mock.calls.find(
      (call) => call.arguments[0] === '/j/subject_abstract'
    );
    assert.deepEqual((detail?.arguments[1] as AxiosRequestConfig).params, {
      subject_id: '37083974',
    });
  });

  it('matches movies using the original title', async () => {
    const api = new Douban();
    stub(api, [suggestion], { r: 0, subject: { ...subject, is_tv: false } });
    assert.equal(
      (
        await api.getRating({
          ...lookup,
          mediaType: 'movie',
          titles: ['Carrie'],
        })
      )?.score,
      7.8
    );
  });

  for (const title of ['哆啦A梦', '哆啦Ａ梦']) {
    it(`finds Doraemon (2005) when Douban omits it for the search spelling ${title}`, async () => {
      const api = new Douban();
      const axios = (api as unknown as { axios: AxiosInstance }).axios;
      // Captured from subject_suggest: uppercase A only returned the 2025
      // film, while lowercase a also returned the 1979 and 2005 TV series.
      const film = {
        id: '36809928',
        title: '哆啦A梦：大雄的绘画奇遇记',
        sub_title: '映画ドラえもん のび太の絵世界物語',
        year: '2025',
      };
      const series = {
        id: '3538051',
        title: '哆啦A梦',
        sub_title: 'ドラえもん',
        year: '2005',
      };
      mock.method(
        axios,
        'get',
        async (path: string, config: AxiosRequestConfig) => {
          if (path === '/j/subject_suggest') {
            return {
              data:
                config.params.q === '哆啦a梦'
                  ? [film, { ...series, id: '1782004', year: '1979' }, series]
                  : config.params.q === '哆啦A梦'
                    ? [film]
                    : [],
            };
          }
          assert.equal(config.params.subject_id, series.id);
          return {
            data: {
              r: 0,
              subject: {
                id: series.id,
                title: '哆啦A梦 ドラえもん‎ (2005)',
                release_year: '2005',
                is_tv: true,
                rate: '9.6',
              },
            },
          };
        }
      );

      const rating = await api.getRating({
        mediaType: 'tv',
        titles: [title, 'ドラえもん'],
        year: 2005,
      });
      assert.equal(rating?.id, '3538051');
      assert.equal(rating?.score, 9.6);
    });
  }

  it('does not repeat a normalized query that was already searched', async () => {
    const api = new Douban();
    const get = stub(api, []);
    assert.equal(
      await api.getRating({ ...lookup, titles: ['missing', 'ｍｉｓｓｉｎｇ'] }),
      null
    );
    assert.equal(get.mock.callCount(), 2);
  });

  it('does not cache failures from the normalized search as a missing title', async () => {
    const api = new Douban();
    const axios = (api as unknown as { axios: AxiosInstance }).axios;
    mock.method(
      axios,
      'get',
      async (_path: string, config: AxiosRequestConfig) => ({
        data: config.params.q === 'carrie' ? '<html>Unavailable</html>' : [],
      })
    );
    await assert.rejects(
      api.getRating(lookup),
      /Invalid Douban search response/
    );
    stub(api);
    assert.equal((await api.getRating(lookup))?.score, 7.8);
  });

  it('rejects a same-name remake with a different year', async () => {
    const api = new Douban();
    const get = stub(api, [{ ...suggestion, year: '1976' }]);
    assert.equal(await api.getRating(lookup), null);
    assert.equal(get.mock.callCount(), 3);
  });

  it('rejects loosely similar titles and unrelated search results', async () => {
    const api = new Douban();
    stub(api, [
      { ...suggestion, title: '另一个故事', sub_title: 'Carrie: The Sequel' },
    ]);
    assert.equal(await api.getRating(lookup), null);
  });

  it('checks the media type and year again in the subject response', async () => {
    for (const mismatch of [{ is_tv: false }, { release_year: '1976' }]) {
      const api = new Douban();
      cacheManager.getCache('douban').flush();
      stub(api, [suggestion], { r: 0, subject: { ...subject, ...mismatch } });
      assert.equal(await api.getRating(lookup), null);
    }
  });

  it('rejects an abstract for a different subject instead of caching it', async () => {
    const api = new Douban();
    stub(api, [suggestion], { r: 0, subject: { ...subject, id: '99999' } });
    await assert.rejects(
      api.getRating(lookup),
      /Invalid Douban subject response/
    );
  });

  it('accepts the first season but never substitutes a later season', async () => {
    const api = new Douban();
    stub(api, [
      { ...suggestion, title: '魔女嘉莉 第一季', sub_title: 'Carrie Season 1' },
    ]);
    assert.equal((await api.getRating(lookup))?.score, 7.8);
    cacheManager.getCache('douban').flush();
    stub(api, [
      { ...suggestion, title: '魔女嘉莉 第二季', sub_title: 'Carrie Season 2' },
    ]);
    assert.equal(await api.getRating(lookup), null);
  });

  it('does not choose arbitrarily between equally matching subjects', async () => {
    const api = new Douban();
    const axios = (api as unknown as { axios: AxiosInstance }).axios;
    mock.method(
      axios,
      'get',
      async (path: string, config: AxiosRequestConfig) => ({
        data:
          path === '/j/subject_suggest'
            ? [suggestion, { ...suggestion, id: '99999' }]
            : { r: 0, subject: { ...subject, id: config.params.subject_id } },
      })
    );
    assert.equal(await api.getRating(lookup), null);
  });

  it('keeps an unrated match without inventing a zero rating', async () => {
    for (const rate of [
      '',
      '0',
      null,
      undefined,
      '暂无评分',
      'NaN',
      '11',
      '-1',
    ]) {
      const api = new Douban();
      cacheManager.getCache('douban').flush();
      stub(api, [suggestion], { r: 0, subject: { ...subject, rate } });
      const rating = await api.getRating(lookup);
      assert.ok(rating);
      assert.equal(rating.score, null);
    }
  });

  it('shares in-flight lookups and caches successful and missing matches', async () => {
    const api = new Douban();
    const get = stub(api);
    const ratings = await Promise.all([
      api.getRating(lookup),
      new Douban().getRating(lookup),
    ]);
    assert.deepEqual(ratings[0], ratings[1]);
    await new Douban().getRating(lookup);
    assert.equal(get.mock.callCount(), 3);

    cacheManager.getCache('douban').flush();
    const miss = new Douban();
    const emptyGet = stub(miss, []);
    assert.equal(await miss.getRating(lookup), null);
    assert.equal(await new Douban().getRating(lookup), null);
    assert.equal(emptyGet.mock.callCount(), 3);
  });

  it('does not cache a blocked or malformed provider response as a missing title', async () => {
    const api = new Douban();
    stub(api, '<html>Provider unavailable</html>');
    await assert.rejects(
      api.getRating(lookup),
      /Invalid Douban search response/
    );
    stub(api);
    assert.equal((await api.getRating(lookup))?.score, 7.8);
  });

  it('rejects an unavailable abstract and propagates network failures', async () => {
    const api = new Douban();
    stub(api, [suggestion], { r: 1 });
    await assert.rejects(
      api.getRating(lookup),
      /Invalid Douban subject response/
    );
    const axios = (api as unknown as { axios: AxiosInstance }).axios;
    mock.method(axios, 'get', async () => {
      throw new Error('timeout');
    });
    await assert.rejects(api.getRating(lookup), /timeout/);
  });

  it('never follows upstream URLs or non-numeric subject IDs', async () => {
    const api = new Douban();
    stub(api, [{ ...suggestion, url: 'https://example.com/untrusted' }]);
    assert.equal(
      (await api.getRating(lookup))?.url,
      'https://movie.douban.com/subject/37083974/'
    );
    cacheManager.getCache('douban').flush();
    const get = stub(api, [{ ...suggestion, id: '../admin' }]);
    assert.equal(await api.getRating(lookup), null);
    assert.equal(get.mock.callCount(), 3);
  });

  it('does not search without enough identifying information', async () => {
    const api = new Douban();
    const get = stub(api);
    assert.equal(await api.getRating({ ...lookup, year: undefined }), null);
    assert.equal(await api.getRating({ ...lookup, titles: ['  '] }), null);
    assert.equal(get.mock.callCount(), 0);
  });
});
