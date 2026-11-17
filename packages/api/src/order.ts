// 中间件顺序常量：顺序是安全属性（鉴权早于计费、监控早于拦截），不依赖注册先后。
export const ORDER = {
  requestId: 10,
  recovery: 20,
  logging: 30,
  cors: 40,
  cacheControl: 50,
  ipBlock: 60,
  apiAuth: 100,
  monitor: 200,
  baseUrl: 300,
  requiredParams: 350,
  access: 400,
  billing: 500,
  rateLimit: 600,
} as const
