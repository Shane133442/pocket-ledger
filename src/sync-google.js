export function jsonp(url, params) {
  return new Promise((resolve, reject) => {
    const callback = `pocketLedger_${crypto.randomUUID().replaceAll("-", "")}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => finish(new Error("Google 中繼無回應，請稍後重試。")), 12000);
    const finish = (error, value) => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
      error ? reject(error) : resolve(value);
    };
    window[callback] = (value) => finish(null, value);
    script.onerror = () => finish(new Error("無法連線到 Google 中繼，請檢查網路或 Apps Script 網址。"));
    const query = new URLSearchParams({ ...params, callback });
    script.src = `${url}?${query}`;
    document.head.append(script);
  });
}
