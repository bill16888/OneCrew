import { redirect } from 'next/navigation';

/**
 * Workspace landing page.
 *
 * The MVP exposes a single workspace, so loading `/` directly drops the
 * user into the seeded `#general` channel — that is the only screen with
 * a fully wired sidebar + composer + AI teammate panel + approval banner.
 * Without this redirect, `/` rendered a "skeleton scaffolded" placeholder
 * outside the workspace layout, so newly-signed-in users saw a sidebar-
 * less splash and had to type a channel URL by hand to reach anything
 * useful.
 *
 * `redirect()` issues an HTTP 307 from the server, so the browser never
 * paints the placeholder. We send the user to the canonical seeded
 * channel id (`chan_general`) rather than just `general` to match the
 * channel rows actually present in the database (Requirements 1.6).
 */
export default function HomePage(): never {
  redirect('/channels/chan_general');
}
