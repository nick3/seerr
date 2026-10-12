import Douban from '@server/api/rating/douban';
import cacheManager from '@server/lib/cache';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

const comment = {
  id: '1234',
  user: { name: '影迷', path: 'https://example.com/untrusted' },
  content: '第一行\n第二行 <script>example</script>',
  rating: '4',
  votes: 12,
  time: '2026-10-12 09:30:00',
};

function stub(api: Douban, data: unknown) {
  return mock.method(
    (api as unknown as { axios: AxiosInstance }).axios,
    'get',
    async () => ({ data })
  );
}

const response = (normal: unknown[] = [comment]) => ({
  retcode: 1,
  result: { normal, total_num: 42, spammed: [{ ...comment, id: '9999' }] },
});

describe('Douban short reviews', () => {
  beforeEach(() => cacheManager.getCache('douban').flush());
  afterEach(() => mock.restoreAll());

  it('fetches public reviews for the matched subject and preserves plain text', async () => {
    const api = new Douban();
    const get = stub(
      api,
      response([comment, comment, { id: 'bad', content: '' }])
    );
    assert.deepEqual(await api.getComments('37083974'), {
      total: 42,
      comments: [
        {
          id: '1234',
          author: '影迷',
          content: comment.content,
          rating: 4,
          votes: 12,
          date: '2026-10-12',
        },
      ],
    });
    assert.equal(
      get.mock.calls[0].arguments[0],
      '/j/subject/37083974/comments'
    );
    assert.deepEqual(
      (get.mock.calls[0].arguments[1] as AxiosRequestConfig).params,
      {
        start: 0,
        limit: 6,
        status: 'P',
        sort: 'new_score',
      }
    );
  });

  it('shares in-flight requests and caches each subject and sort separately', async () => {
    const api = new Douban();
    const get = stub(api, response());
    const results = await Promise.all([
      api.getComments('37083974'),
      new Douban().getComments('37083974'),
    ]);
    assert.deepEqual(results[0], results[1]);
    await new Douban().getComments('37083974');
    assert.equal(get.mock.callCount(), 1);

    await api.getComments('37083974', 'time');
    await api.getComments('1292052', 'time');
    assert.equal(get.mock.callCount(), 3);
    assert.equal(
      (get.mock.calls[1].arguments[1] as AxiosRequestConfig).params.sort,
      'time'
    );
    assert.equal(get.mock.calls[2].arguments[0], '/j/subject/1292052/comments');
  });

  it('allows comments without a rating, author or date', async () => {
    const api = new Douban();
    stub(
      api,
      response([
        { id: 1, content: '未打分的短评' },
        { ...comment, id: '2', rating: '0', votes: -1, time: '2026-02-30' },
        { ...comment, id: '3', rating: '6', time: 'invalid' },
      ])
    );
    const result = await api.getComments('37083974');
    assert.equal(result.comments.length, 3);
    assert.deepEqual(result.comments[0], {
      id: '1',
      author: '',
      content: '未打分的短评',
      rating: null,
      votes: 0,
      date: null,
    });
    assert.ok(
      result.comments.every(
        (item) => item.rating === null && item.date === null
      )
    );
    assert.equal(result.comments[1].votes, 0);
  });

  it('caps the preview while preserving the provider order and total', async () => {
    const api = new Douban();
    stub(
      api,
      response(
        Array.from({ length: 8 }, (_, i) => ({ ...comment, id: String(i + 1) }))
      )
    );
    const result = await api.getComments('37083974');
    assert.deepEqual(
      result.comments.map((item) => item.id),
      ['1', '2', '3', '4', '5', '6']
    );
    assert.equal(result.total, 42);
  });

  it('accepts and caches a valid empty review list', async () => {
    const api = new Douban();
    const get = stub(api, { retcode: 1, result: { normal: [], total_num: 0 } });
    assert.deepEqual(await api.getComments('37083974'), {
      comments: [],
      total: 0,
    });
    await api.getComments('37083974');
    assert.equal(get.mock.callCount(), 1);
  });

  it('does not turn a blocked or malformed response into a cached empty list', async () => {
    for (const data of [
      '<html>unavailable</html>',
      { retcode: 0 },
      { retcode: 1, result: { total_num: 42 } },
      response([{ text: 'unexpected schema' }]),
    ]) {
      cacheManager.getCache('douban').flush();
      const api = new Douban();
      stub(api, data);
      await assert.rejects(
        api.getComments('37083974'),
        /Invalid Douban comments response/
      );
      stub(api, response());
      assert.equal((await api.getComments('37083974')).comments.length, 1);
    }
  });

  it('allows retry after a network failure', async () => {
    const api = new Douban();
    mock.method(
      (api as unknown as { axios: AxiosInstance }).axios,
      'get',
      async () => {
        throw new Error('timeout');
      }
    );
    await assert.rejects(api.getComments('37083974'), /timeout/);
    stub(api, response());
    assert.equal((await api.getComments('37083974')).comments.length, 1);
  });

  it('rejects paths, URLs and unsupported sorts before making any request', async () => {
    const api = new Douban();
    const get = stub(api, response());
    for (const id of ['../123', 'https://example.com', '123/comments', '']) {
      await assert.rejects(
        api.getComments(id),
        /Invalid Douban comments lookup/
      );
    }
    await assert.rejects(
      api.getComments('37083974', 'unknown' as 'time'),
      /Invalid Douban comments lookup/
    );
    assert.equal(get.mock.callCount(), 0);
  });
});
