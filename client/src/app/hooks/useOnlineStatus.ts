import { useState, useEffect } from 'react';

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    let generation = 0;

    const checkServer = async () => {
      const currentGeneration = ++generation;
      if (!navigator.onLine) {
        controller?.abort();
        if (active && generation === currentGeneration) setIsOnline(false);
        return;
      }

      controller?.abort();
      const probeController = new AbortController();
      controller = probeController;
      const timeout = window.setTimeout(() => probeController.abort(), 5000);
      try {
        const response = await fetch('/api/ready', {
          credentials: 'include',
          cache: 'no-store',
          signal: probeController.signal,
        });
        if (active && generation === currentGeneration) setIsOnline(response.ok);
      } catch {
        if (active && generation === currentGeneration) setIsOnline(false);
      } finally {
        window.clearTimeout(timeout);
        if (controller === probeController) controller = null;
      }
    };

    const handleOnline = () => { void checkServer(); };
    const handleOffline = () => {
      generation += 1;
      controller?.abort();
      setIsOnline(false);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void checkServer();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);
    const interval = window.setInterval(() => { void checkServer(); }, 30_000);
    void checkServer();

    return () => {
      active = false;
      generation += 1;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return isOnline;
}
