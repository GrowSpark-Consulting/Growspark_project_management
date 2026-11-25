'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { BrandChip, PRODUCT_NAME } from '@/components/brand-chip';

interface LoadingContextType {
  isLoading: boolean;
  progress: number;
  startLoading: () => void;
  stopLoading: () => void;
  // Content-ready signaling for widgets/components
  registerPendingContent: () => void;
  markContentReady: () => void;
}

const LoadingContext = createContext<LoadingContextType | undefined>(undefined);

export function useLoading() {
  const context = useContext(LoadingContext);
  if (!context) {
    // Return no-op functions for SSR or when context is not available
    return {
      isLoading: false,
      progress: 0,
      startLoading: () => {},
      stopLoading: () => {},
      registerPendingContent: () => {},
      markContentReady: () => {},
    };
  }
  return context;
}

// Minimum time to show loading overlay (ms)
const MIN_LOADING_TIME = 800;
// Maximum wait time for content to be ready (ms)
const MAX_CONTENT_WAIT_TIME = 5000;

// Navigation bar: hidden after this long even if the next page never arrives (cancelled navigation).
// Long enough to cover the backend waking up from sleep.
const MAX_NAVIGATION_TIME = 60000;

/**
 * The full-screen splash covers the app only while it first loads in a tab. Moving between pages shows
 * a thin bar at the top instead: the current page stays visible and usable until the next one is ready
 * (there are no route-level loading screens), and the bar finishes as soon as the next page is there.
 * (Covering or blanking the page on every navigation made each click look like a full page reload.)
 */
export function LoadingProvider({ children }: { children: ReactNode }) {
  // Start with loading true for initial page load
  const [isLoading, setIsLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [navProgress, setNavProgress] = useState(0);
  const navigationId = useRef(0);
  const navigationTimer = useRef<NodeJS.Timeout | null>(null);
  const [progress, setProgress] = useState(0);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const loadingStartTime = useRef<number>(Date.now());
  const pendingStop = useRef<boolean>(false);
  const pendingContentCount = useRef<number>(0);
  const contentReadyTimeout = useRef<NodeJS.Timeout | null>(null);
  const isTabVisible = useRef<boolean>(true);

  const startLoading = useCallback(() => {
    loadingStartTime.current = Date.now();
    pendingStop.current = false;
    pendingContentCount.current = 0;
    setIsLoading(true);
    setProgress(0);
  }, []);

  const stopLoading = useCallback(() => {
    const elapsed = Date.now() - loadingStartTime.current;
    const remainingTime = Math.max(0, MIN_LOADING_TIME - elapsed);

    // Set progress to 100 immediately
    setProgress(100);

    // Delay hiding to ensure minimum display time
    setTimeout(() => {
      if (!pendingStop.current) {
        setIsLoading(false);
        setProgress(0);
        pendingContentCount.current = 0;
      }
    }, remainingTime + 300);
  }, []);

  // Register pending content - widgets call this when they start loading
  const registerPendingContent = useCallback(() => {
    pendingContentCount.current += 1;
    // Clear any existing timeout since we have new pending content
    if (contentReadyTimeout.current) {
      clearTimeout(contentReadyTimeout.current);
      contentReadyTimeout.current = null;
    }
  }, []);

  // Mark content as ready - widgets call this when they finish loading
  const markContentReady = useCallback(() => {
    pendingContentCount.current = Math.max(0, pendingContentCount.current - 1);

    // If all content is ready, stop loading
    if (pendingContentCount.current === 0 && isLoading) {
      stopLoading();
    }
  }, [isLoading, stopLoading]);

  // Simulate progress when loading
  useEffect(() => {
    if (!isLoading) return;

    const intervals = [
      { delay: 100, target: 20 },
      { delay: 250, target: 40 },
      { delay: 400, target: 60 },
      { delay: 600, target: 75 },
      { delay: 900, target: 85 },
      { delay: 1200, target: 90 },
      { delay: 2000, target: 95 },
    ];

    const timeouts: NodeJS.Timeout[] = [];

    intervals.forEach(({ delay, target }) => {
      const timeout = setTimeout(() => {
        setProgress(prev => Math.max(prev, target));
      }, delay);
      timeouts.push(timeout);
    });

    return () => {
      timeouts.forEach(clearTimeout);
    };
  }, [isLoading]);

  // Handle initial page load
  useEffect(() => {
    if (isInitialLoad) {
      // Wait for the page to be interactive before stopping
      const handleLoad = () => {
        // Set a timeout to wait for content, but have a max wait time
        contentReadyTimeout.current = setTimeout(() => {
          // If we still have pending content after max wait, stop anyway
          if (pendingContentCount.current > 0) {
            console.warn(`Loading overlay timeout: ${pendingContentCount.current} pending content items`);
          }
          setIsInitialLoad(false);
          stopLoading();
        }, MAX_CONTENT_WAIT_TIME);

        // Also check if no pending content, stop immediately
        setTimeout(() => {
          if (pendingContentCount.current === 0) {
            if (contentReadyTimeout.current) {
              clearTimeout(contentReadyTimeout.current);
            }
            setIsInitialLoad(false);
            stopLoading();
          }
        }, MIN_LOADING_TIME);
      };

      if (document.readyState === 'complete') {
        handleLoad();
      } else {
        window.addEventListener('load', handleLoad);
        // Fallback timeout in case load event never fires
        const fallback = setTimeout(handleLoad, 3000);
        return () => {
          window.removeEventListener('load', handleLoad);
          clearTimeout(fallback);
        };
      }
    }
  }, [isInitialLoad, stopLoading]);

  // Navigation bar: started by a link click, finished when the new page is there
  const finishNavigation = useCallback(() => {
    if (navigationTimer.current) clearTimeout(navigationTimer.current);
    navigationTimer.current = null;
    const id = navigationId.current;
    setNavProgress(100);
    setTimeout(() => {
      if (navigationId.current !== id) return; // another navigation started meanwhile
      setNavigating(false);
      setNavProgress(0);
    }, 250);
  }, []);

  const startNavigation = useCallback(() => {
    navigationId.current += 1;
    setNavigating(true);
    setNavProgress(15);
    if (navigationTimer.current) clearTimeout(navigationTimer.current);
    navigationTimer.current = setTimeout(finishNavigation, MAX_NAVIGATION_TIME);
  }, [finishNavigation]);

  // Creep towards 90% while the next page loads
  useEffect(() => {
    if (!navigating) return;
    const tick = setInterval(() => setNavProgress((p) => (p >= 90 ? p : p + (90 - p) * 0.15)), 200);
    return () => clearInterval(tick);
  }, [navigating]);

  // Track route changes (but not on initial load)
  useEffect(() => {
    if (navigating) finishNavigation();
    if (!isInitialLoad) {
      // When route changes, check if we should stop loading
      // Give a small delay for any pending content to register
      setTimeout(() => {
        if (pendingContentCount.current === 0) {
          stopLoading();
        }
      }, 500);
    }
    // Only a change of page (path or query) finishes a navigation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams, stopLoading, isInitialLoad]);

  // Intercept navigation (clicks on internal links)
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // New tab / window, or not the main button: the page does not change here
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api')) return;
      // Same page (only a #hash differs): nothing loads
      const url = new URL(href, window.location.href);
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      startNavigation();
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [startNavigation]);

  // Handle tab visibility changes (prevent reload on tab switch)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Tab became visible - if we were loading due to unload, cancel it
        isTabVisible.current = true;
        // Don't restart loading, just resume normal state
        if (pendingStop.current) {
          pendingStop.current = false;
        }
      } else {
        isTabVisible.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return (
    <LoadingContext.Provider value={{
      isLoading,
      progress,
      startLoading,
      stopLoading,
      registerPendingContent,
      markContentReady
    }}>
      {children}
      <NavigationBar visible={navigating} progress={navProgress} />
      <LoadingOverlay isVisible={isLoading} progress={progress} />
    </LoadingContext.Provider>
  );
}

/** Thin bar along the top while the next page loads; never covers or blocks the page. */
function NavigationBar({ visible, progress }: { visible: boolean; progress: number }) {
  return (
    <div
      data-testid="navigation-progress"
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-0 z-[9999] h-[3px] transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="h-full bg-primary transition-[width] duration-200 ease-out" style={{ width: `${progress}%` }} />
    </div>
  );
}

interface LoadingOverlayProps {
  isVisible: boolean;
  progress: number;
}

function LoadingOverlay({ isVisible, progress }: LoadingOverlayProps) {
  const [shouldRender, setShouldRender] = useState(false);

  useEffect(() => {
    if (isVisible) {
      setShouldRender(true);
    } else {
      const timeout = setTimeout(() => setShouldRender(false), 400);
      return () => clearTimeout(timeout);
    }
  }, [isVisible]);

  if (!shouldRender) return null;

  return (
    <div
      data-testid="loading-overlay"
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-bg transition-opacity duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* Product mark: moss chip + name (Grow Spark Workspace) */}
      <div className="mb-8 flex items-center gap-3 animate-pulse-slow">
        <BrandChip className="h-10 w-10 text-lg" />
        <span className="text-[22px] leading-[30px] font-semibold text-ink">{PRODUCT_NAME}</span>
      </div>

      {/* Progress bar container */}
      <div className="w-64 space-y-3">
        {/* Progress bar */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Percentage text */}
        <div className="text-center">
          <span className="text-sm font-medium text-gray-600 tabular-nums">
            {Math.round(progress)}%
          </span>
        </div>
      </div>

      {/* Loading text */}
      <p className="mt-4 text-sm text-gray-500 animate-pulse">
        Loading...
      </p>
    </div>
  );
}

export default LoadingOverlay;
