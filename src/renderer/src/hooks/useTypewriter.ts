import { useEffect, useState } from 'react';

/**
 * 逐字符展示 `text`。
 * `seed` 变化时重置动画——传入时间戳，这样 agent 重复输出同一行时，
 * 相同字符串也会重新播放。
 *
 * @param text  要展示的完整字符串。
 * @param seed  任意值；变化时重启打字机效果。
 * @param cps   每秒字符数。默认 90。
 */
export function useTypewriter(text: string, seed: unknown, cps = 90): {
  shown: string;
  done: boolean;
} {
  const [shown, setShown] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    setShown('');
    setDone(false);
    if (!text) { setDone(true); return; }
    let i = 0;
    const intervalMs = Math.max(8, Math.floor(1000 / cps));
    const id = window.setInterval(() => {
      i++;
      setShown(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(id);
        setDone(true);
      }
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [text, seed, cps]);

  return { shown, done };
}
