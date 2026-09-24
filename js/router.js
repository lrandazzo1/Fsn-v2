/**
 * router.js
 * -----------------------------------------------------------------------------
 * Tiny hash router for the app shell.
 *
 *   #/            Home Dashboard
 *   #/league      League Overview
 *   #/draft       Draft Room / Board
 *   #/team/:id    Team Roster / Matchup
 *
 * Routes are declared as patterns with `:params`; the matching view's `enter()`
 * runs on navigation and `leave()` on exit, so views can start/stop timers
 * without leaking work across screens.
 */

export class Router {
  /**
   * @param {Array<{path: string, name: string, view: {enter?: Function, leave?: Function, render?: Function}}>} routes
   * @param {{onChange?: Function, fallback?: string}} [options]
   */
  constructor(routes, { onChange, fallback = '/' } = {}) {
    this.routes = routes.map((route) => ({ ...route, matcher: compile(route.path) }));
    this.onChange = onChange || (() => {});
    this.fallback = fallback;
    this.current = null;
    this.handler = () => this.resolve();
  }

  start() {
    window.addEventListener('hashchange', this.handler);
    if (!window.location.hash) window.location.hash = `#${this.fallback}`;
    else this.resolve();
    return this;
  }

  stop() {
    window.removeEventListener('hashchange', this.handler);
  }

  /** Programmatic navigation — `router.go('/team/4')`. */
  go(path) {
    if (window.location.hash === `#${path}`) this.resolve();
    else window.location.hash = `#${path}`;
  }

  get path() {
    return window.location.hash.replace(/^#/, '') || this.fallback;
  }

  resolve() {
    const path = this.path;
    const match = this.routes
      .map((route) => ({ route, params: route.matcher(path) }))
      .find((entry) => entry.params !== null);

    const target = match || {
      route: this.routes.find((r) => r.path === this.fallback),
      params: {}
    };
    if (!target.route) return;

    if (this.current && this.current.route !== target.route) {
      this.current.route.view?.leave?.(this.current.params);
    }

    this.current = target;
    target.route.view?.enter?.(target.params);
    this.onChange({ name: target.route.name, path, params: target.params });
  }
}

/** '/team/:id' -> (path) => ({id}) | null */
function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      keys.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  const regex = new RegExp(`^${source}/?$`);

  return (path) => {
    const match = regex.exec(path);
    if (!match) return null;
    return keys.reduce((params, key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
      return params;
    }, {});
  };
}
