// 夹具插件 v2：只改正文，用来证明 reload / rollback 拿到的是不同一代
export default {
  handlers: {
    search: async (ctx) => ({
      bookList: [
        {
          bookId: 'b1',
          name: `v2 搜到的：${ctx.params.key ?? ''}`,
          author: '夹具',
          kind: '小说',
          wordCount: '1000',
          lastChapter: '第一章',
          intro: '夹具',
          coverUrl: '',
        },
      ],
    }),
    content: async () => ({ contentType: 'novel', data: { content: 'v2 body' } }),
  },
}
