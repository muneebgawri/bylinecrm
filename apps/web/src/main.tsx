import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createQueryClient } from './api/queries';
import { mayReloadForNewBuild, reloadForNewBuild } from './lib/staleBuild';
import { router } from './router';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

// Vite's own signal that a lazily loaded chunk (a panel, a dialog) is gone after a deploy.
window.addEventListener('vite:preloadError', (event) => {
    if (!mayReloadForNewBuild()) return;
    event.preventDefault();
    reloadForNewBuild();
});

const queryClient = createQueryClient();

createRoot(root).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <TooltipProvider>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>
    </StrictMode>,
);
