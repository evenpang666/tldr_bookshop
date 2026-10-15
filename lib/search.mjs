import { networkJSON } from './network.mjs';
import { books } from '../data/catalog.mjs';

export async function searchBooks(query, { request = networkJSON } = {}) {
  const q = query.trim().slice(0, 200);
  const errors = [];
  try {
    const data = await request(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=30&fields=key,title,author_name,first_publish_year,first_sentence&lang=zh`);
    const rows = (data.docs || []).filter(b => b.title && b.author_name?.length).map((b, i) => ({ id: String(b.key).startsWith('/') ? b.key : `/works/${b.key}`, title: b.title.slice(0, 200), author: b.author_name.slice(0, 2).join('、').slice(0, 200), category: '在线书库', year: b.first_publish_year, color: i % 8, description: (Array.isArray(b.first_sentence) ? b.first_sentence[0] : b.first_sentence)?.slice(0, 180) || '在线书目暂未提供内容简介，可打开书籍后联网提炼。', classic: false }));
    if (rows.length) return { books: rows, total: data.numFound ?? data.num_found ?? rows.length, source: 'Open Library' };
  } catch (error) { errors.push(error); }
  try {
    const data = await request(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=30&printType=books`);
    const rows = (data.items || []).filter(b => b.volumeInfo?.title && b.volumeInfo?.authors?.length).map((b, i) => ({ id: `google-${b.id}`, title: b.volumeInfo.title.slice(0, 200), author: b.volumeInfo.authors.slice(0, 2).join('、').slice(0, 200), category: '在线书库', color: i % 8, description: String(b.volumeInfo.description || '在线书目暂未提供内容简介，可打开书籍后联网提炼。').replace(/<[^>]*>/g, '').slice(0, 180), classic: false }));
    if (rows.length) return { books: rows, total: data.totalItems || rows.length, source: 'Google Books（备用书库）' };
  } catch (error) { errors.push(error); }
  const normalized = q.toLowerCase();
  const local = books.filter(b => `${b.title} ${b.author} ${(b.aliases || []).join(' ')}`.toLowerCase().includes(normalized));
  if (errors.length) return { books: local, total: local.length, source: '本地书库', degraded: true, notice: local.length ? '在线书库暂时不可达，已返回本地匹配。' : '在线书库暂时不可达。可直接输入书名与作者阅读，或稍后重试。' };
  return { books: [], total: 0, source: '在线书库' };
}
