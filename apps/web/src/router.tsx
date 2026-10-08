import { createBrowserRouter } from 'react-router';
import { Home } from './routes/home';

/** Every route is declared here; a page that is not registered does not exist. */
export const router = createBrowserRouter([{ path: '/', element: <Home /> }]);
