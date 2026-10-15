import test from 'node:test';
import assert from 'node:assert/strict';
import { books } from '../data/catalog.mjs';
import { series } from '../data/series.mjs';
import { searchBooks } from '../lib/search.mjs';

test('series resolve to unique catalog entries, ordered volumes and correct authors', () => {
  assert.equal(new Set(series.map(group => group.id)).size, series.length);
  const linked = new Set();
  for (const group of series) {
    assert.equal(new URL(group.source).protocol, 'https:');
    assert.equal(new Set(group.works.map(work => work.title)).size, group.works.length);
    for (const [index, work] of group.works.entries()) {
      const matches = books.filter(book => book.title === work.title);
      assert.equal(matches.length, 1, work.title);
      const book = matches[0]; linked.add(book.id);
      assert.equal(book.author, work.author, work.title);
      const membership = book.series.find(item => item.id === group.id);
      assert.equal(membership.order, index + 1); assert.equal(membership.total, group.works.length);
      assert.ok(book.aliases.includes(group.name));
    }
  }
  assert.ok(books.filter(book => book.id.startsWith('series-')).every(book => linked.has(book.id)));
});

test('expansion preserves existing bookmark identifiers and distinguishes continuations', () => {
  const originals = books.filter(book => book.id.startsWith('classic-'));
  assert.equal(originals.length, 429);
  for (let i = 1; i <= 429; i++) assert.ok(originals.some(book => book.id === `classic-${i}`));
  assert.equal(books.find(book => book.title === '红楼梦').id, 'classic-1');
  assert.equal(books.find(book => book.title === '斯佳丽').author, '亚历山德拉·里普利');
  assert.equal(books.find(book => book.title === '拉玛2号').author, '阿瑟·克拉克、金特里·李');
  assert.equal(books.find(book => book.title === '与拉玛相会').author, '阿瑟·克拉克');
  assert.equal(books.filter(book => book.title === '铁面人').length, 0);
  assert.ok(!books.some(book => /凛冬的寒风|春晓的梦想/.test(book.title)));
});

test('offline catalog lookup finds complete series and alternate book names', async () => {
  const request = async () => { throw new Error('offline fixture'); };
  const foundation = await searchBooks('基地', { request });
  assert.equal(foundation.books.length, 7);
  const mansions = await searchBooks('馆系列', { request });
  assert.equal(mansions.books.length, 9);
  const poirot = await searchBooks('赫尔克里·波洛长篇', { request });
  assert.equal(poirot.books.length, 33);
  const alias = await searchBooks('Mona Lisa Overdrive', { request });
  assert.deepEqual(alias.books.map(book => book.title), ['重启蒙娜丽莎']);
});
