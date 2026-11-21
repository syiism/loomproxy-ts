// 夹具插件（不是数据源实现）：只用来验宿主的分层/换代/回滚
export default (sdk) => ({
  handlers: {
    search: async (ctx) => ({
      bookList: [
        {
          bookId: 'b1',
          name: `搜到的：${ctx.params.key ?? ''}`,
          author: '夹具',
          kind: 'wrong_source,小说',
          wordCount: '1000',
          lastChapter: '第一章',
          intro: '夹具',
          coverUrl: '',
        },
      ],
    }),
    content: async () => ({ contentType: 'novel', data: { content: 'v1 body' } }),
  },
  onBoot: (ctx) => ctx.log('v1 boot'),
})
