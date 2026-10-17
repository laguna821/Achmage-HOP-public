// A Node API that the engine's requests never call (the Node bundle tree-shakes it out): calling it fails
// instead of quietly doing something else.
export const unavailable=name=>()=>{throw new Error(`이 실행 환경에서는 ${name}을(를) 지원하지 않습니다.`);};
