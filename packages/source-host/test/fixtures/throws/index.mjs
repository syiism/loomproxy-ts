// 夹具：工厂抛错，宿主要记 failed 且不拖垮别人
export default (sdk) => {
  throw new Error('boom')
}
