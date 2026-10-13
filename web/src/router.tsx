import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "./shell/AppShell";
import { NotFound } from "./shell/NotFound";

/** Route-level code splitting: each plane and the coverage board is its own chunk. */
export const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
    children: [
      { index: true, element: <Navigate to="/shopper/1" replace /> },
      { path: "shopper", element: <Navigate to="/shopper/1" replace /> },
      { path: "shopper/:beat", lazy: () => import("./routes/ShopperRoute") },
      { path: "ops", element: <Navigate to="/ops/1" replace /> },
      { path: "ops/replay", lazy: () => import("./ops/ReplayRoute") },
      { path: "ops/replay/:runId", lazy: () => import("./ops/ReplayRoute") },
      { path: "ops/tokens", lazy: () => import("./ops/TokensRoute") },
      { path: "ops/traces", lazy: () => import("./ops/TracesRoute") },
      { path: "ops/traces/:traceId", lazy: () => import("./ops/TracesRoute") },
      { path: "ops/:beat", lazy: () => import("./routes/OpsRoute") },
      { path: "coverage", lazy: () => import("./coverage/CoverageRoute") },
      { path: "coverage/:techniqueId", lazy: () => import("./coverage/CoverageRoute") },
      {
        path: "shop",
        lazy: () => import("./store/StoreLayout"),
        children: [
          { index: true, lazy: () => import("./store/pages/HomePage") },
          { path: "search", lazy: () => import("./store/pages/SearchPage") },
          { path: "p/:pid", lazy: () => import("./store/pages/ProductPage") },
          { path: "cart", lazy: () => import("./store/pages/CartPage") },
          { path: "checkout", lazy: () => import("./store/pages/CheckoutPage") },
          { path: "orders", lazy: () => import("./store/pages/MiscPages").then((m) => ({ Component: m.OrdersPage })) },
          { path: "order/:orderId", lazy: () => import("./store/pages/OrderPage") },
          { path: "account", lazy: () => import("./store/pages/AccountPages").then((m) => ({ Component: m.AccountPage })) },
          { path: "account/wallet", lazy: () => import("./store/pages/AccountPages").then((m) => ({ Component: m.WalletPage })) },
          { path: "account/addresses", lazy: () => import("./store/pages/AccountPages").then((m) => ({ Component: m.AddressesPage })) },
          { path: "stores", lazy: () => import("./store/pages/MiscPages").then((m) => ({ Component: m.StoresPage })) },
          { path: "lists", lazy: () => import("./store/pages/MiscPages").then((m) => ({ Component: m.ListsPage })) },
          { path: "help", lazy: () => import("./store/pages/MiscPages").then((m) => ({ Component: m.HelpPage })) },
        ],
      },
      { path: "guide", lazy: () => import("./guide/GuideRoute") },
      { path: "guide/:featureId", lazy: () => import("./guide/GuideRoute") },
      { path: "triage", lazy: () => import("./triage/TriageRoute") },
      { path: "*", Component: NotFound },
    ],
  },
]);
