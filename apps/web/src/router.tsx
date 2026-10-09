import { createBrowserRouter } from 'react-router';
import { onUnauthorized } from './api/client';
import { routes } from './routes/manifest';
import { signInPath } from './routes/paths';

/** The manifest is the only source of routes; see `routes/manifest.tsx`. */
export const router = createBrowserRouter(routes);

/**
 * A session that expires mid-use surfaces as a 401 from whatever request ran next. One
 * subscription sends the person to sign-in with where they were; no page handles 401 itself.
 */
onUnauthorized(() => {
    const here = router.state.location;
    if (here.pathname !== signInPath())
        void router.navigate(signInPath(here.pathname + here.search), { replace: true });
});
