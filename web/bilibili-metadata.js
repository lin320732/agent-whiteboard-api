// This document is sandboxed without allow-same-origin. Bilibili's JSONP can
// provide public identifiers but cannot read the board or its login state.
const input = new URLSearchParams(location.search);
const bvid = input.get('bvid'), aid = input.get('aid'), page = input.get('p') || '1';
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const send = ids => parent.postMessage({type: 'whiteboard-bilibili-metadata', ids}, new URL(location.href).origin);
if ((bvid ? !/^BV[0-9A-Za-z]{10}$/.test(bvid) : !/^[1-9][0-9]{0,15}$/.test(aid || '') || !positiveId(Number(aid))) || !/^[1-9][0-9]{0,3}$/.test(page)) {
  send(null);
} else {
  window.whiteboardVideoInfo = result => {
    const data = result?.data;
    const part = Array.isArray(data?.pages) ? data.pages.find(item => item.page === Number(page)) : null;
    const matches = bvid ? data?.bvid === bvid : String(data?.aid) === aid;
    send(result?.code === 0 && matches && positiveId(data?.aid) && positiveId(part?.cid) ? {aid: data.aid, cid: part.cid} : null);
  };
  const params = new URLSearchParams({[bvid ? 'bvid' : 'aid']: bvid || aid, p: page, jsonp: 'jsonp', callback: 'whiteboardVideoInfo'});
  const script = document.createElement('script');
  script.src = `https://api.bilibili.com/x/web-interface/wbi/view?${params}`;
  script.onerror = () => send(null);
  document.head.append(script);
}
