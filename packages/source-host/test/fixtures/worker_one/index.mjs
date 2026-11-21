// 夹具：跑在 worker 线程里。**不取数**，只证明"worker 里的 handler 能跑通并回传 DTO"。
export default (sdk) => ({
  handlers: {
    search: async (ctx) => ({
      bookList: [
        {
          bookId: 'w1',
          name: `worker 搜到：${ctx.params.key ?? ''}`,
          author: '夹具',
          kind: '小说',
          wordCount: '',
          lastChapter: '',
          intro: '',
          coverUrl: '',
        },
      ],
    }),
  },
})
