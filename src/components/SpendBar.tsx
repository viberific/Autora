import { memo, useState } from "react";
import { money } from "./Billing";
import { barVendor, creditTotal, ownSpent, spendView, vendorSpendView } from "../lib/spend";
import { SpendPeek } from "./SpendPeek";
import { VendorLogo } from "./VendorLogo";

/** What `/api/usage` answers with, as far as this bar is concerned. */
export type Usage = {
  month: { cost: number };
  lifetime: { cost: number };
  budget: { monthly_usd: number | null };
  /** What each vendor's own balance says, when it can be read at all. One entry
      per vendor; each is that account's money alone. */
  vendors?: {
    /** Which vendor's money this is. */
    provider: string;
    label: string;
    topped_up_usd: number | null;
    balance_usd: number;
    lifetime_usd: number | null;
    /** True only for the one line that is the whole truth of the ledger: a
        single vendor's money with nobody else's turns in it. Only that line may
        draw this bar. */
    headline: boolean;
    /** False when there is no paid-in figure, so there is no credit to draw. */
    spent_known: boolean;
    /** What this vendor's own turns cost this month, with nobody else's in it. */
    month_usd?: number;
    /** True for the account the console is spending right now. */
    selected?: boolean;
  }[];
  /** Spend at vendors that publish no balance (OpenAI, Gemini, Anthropic):
      there is no till to read, so each is the month its own turns cost. Kept
      apart from `vendors`, which means money in a till. */
  vendors_without_till?: {
    provider: string;
    label: string;
    month_usd: number;
    selected?: boolean;
  }[];
};

/**
 * The money, in the three spans it is actually thought about, over the composer.
 *
 * With several APIs, one line each -- always open, no combined bar to tap --
 * behind its own white mark. Otherwise one bar for the month. Each vendor line
 * is that account's money alone: what was consumed of what was paid in there,
 * what is left when there is no paid-in figure, or, for a vendor that publishes
 * no balance at all, what its turns cost this month. The session's own spend
 * sits under the list, because it is the question asked most often.
 *
 * A tap opens a card of the figures over the chat -- see SpendPeek -- with
 * Usage, ceiling and all, one button further on.
 *
 * Small, and never in the way: it says a number you would otherwise leave the
 * chat to look up, and the thread above it loses 14px for that.
 */
export const SpendBar = memo(function SpendBar({
  spent,
  session,
  budget,
  lifetime,
  vendors,
  withoutTill,
  onOpen,
}: {
  spent: number;
  session: number;
  budget: number | null;
  /** Everything the ledger has ever counted, which is the credit consumed. */
  lifetime: number;
  /** Every vendor's own balance this app was able to read, one each. */
  vendors?: Usage["vendors"];
  /** Vendors with no balance to read, whose spend the ledger counted. */
  withoutTill?: Usage["vendors_without_till"];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);

  /* Per-provider lines when more than one till can be named; the old single bar
     otherwise. A vendor that publishes no balance counts too, as long as the
     ledger counted money at it this month. */
  const readableVendors = [
    ...(vendors ?? []),
    /* No till, but money went out there: a line the month speaks for. */
    ...(withoutTill ?? []).map((v) => ({
      provider: v.provider,
      label: v.label,
      topped_up_usd: null,
      balance_usd: 0,
      lifetime_usd: null,
      headline: false,
      spent_known: false,
      month_usd: v.month_usd,
      selected: v.selected,
    })),
  ].filter((v) => v.spent_known || v.balance_usd > 0 || (v.month_usd ?? 0) > 0);
  const multiVendor = readableVendors.length > 1;

  if (multiVendor) {
    const rows = readableVendors
      .map((v) => ({
        month: v.month_usd ?? 0,
        view: vendorSpendView({
          provider: v.provider,
          label: v.label,
          spent: v.lifetime_usd,
          paid: v.topped_up_usd,
          balance: v.balance_usd,
          month: v.month_usd ?? 0,
        }),
      }))
      .filter((row) => row.view.show);
    if (rows.length === 0) return null;

    const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;

    return (
      <>
        {/* No combined bar: one line per API, always open. The list is the bar
            now, so there is nothing to tap to see whose money is whose. */}
        <div className="spend-stack is-open">
          <div className="spend-each">
            {rows.map(({ view, month }) => {
              const rowTone = view.over ? "is-over" : view.near ? "is-near" : "";
              /* Said as what is left, set first: the bar beside these words
                 drains. A vendor that only publishes a balance has no credit
                 to consume, so its whole bar is what is left there. A vendor
                 with no till at all has no meter: its line is the month. */
              const leftHere = Math.max(0, (view.paid ?? 0) - view.drawn);
              const leftShare = view.ledgerOnly
                ? 0
                : view.remaining
                  ? 1
                  : view.paid && view.paid > 0
                    ? Math.min(1, leftHere / view.paid)
                    : 0;
              const figures = view.ledgerOnly
                ? `${money(month)} this month`
                : view.remaining
                  ? `${money(view.drawn)} left`
                  : `${money(leftHere)} left of ${money(view.paid!)}`;
              const said = view.ledgerOnly
                ? `${view.label}: ${money(month)} this month, no balance published`
                : `${view.label}: ${figures}, ${money(month)} this month`;
              return (
                <div key={view.provider} className={`spend-row ${rowTone}`.trim()} title={said}>
                  <VendorLogo provider={view.provider} size={14} className="spend-row-logo" />
                  <span className="spend-row-name">{view.label}</span>
                  <span className="spend-track" aria-hidden="true">
                    <i
                      className={`spend-used ${leftShare > 0 ? "is-any" : ""}`.trim()}
                      style={{ width: share(leftShare) }}
                    />
                  </span>
                  <span className="spend-text" aria-label={said}>
                    <span className="spend-long">
                      {view.ledgerOnly ? figures : `${figures} · ${money(month)} this month`}
                    </span>
                    <span className="spend-short">
                      {view.ledgerOnly
                        ? money(month)
                        : view.remaining
                          ? money(view.drawn)
                          : `${money(leftHere)}/${money(view.paid!)}`}
                    </span>
                  </span>
                </div>
              );
            })}
            <div className="spend-foot">
              <span className="spend-session">
                {session > 0 ? `${money(session)} this session` : "nothing spent this session"}
              </span>
              <button type="button" className="spend-more" onClick={() => setOpen(true)}>
                Details
              </button>
            </div>
          </div>
        </div>
        {open && <SpendPeek session={session} onUsage={onOpen} onClose={() => setOpen(false)} />}
      </>
    );
  }

  /* Single bar: the till of the account this console is spending, when it can
     be read at all; the month against the ceiling otherwise. */
  const chosen = barVendor(vendors);
  const credit = creditTotal(chosen ?? null);
  /* The money this bar shows is one vendor's money, so the month beside its
     credit is that vendor's own: the ledger's whole month may be mostly another
     API's turns, and printing it here reads as this account's spend. */
  const ownMonth =
    credit !== null && chosen && typeof chosen.month_usd === "number" ? chosen.month_usd : spent;
  const view = spendView({
    spent: ownMonth,
    session,
    budget,
    lifetime: credit !== null ? ownSpent(chosen, lifetime) : lifetime,
    credit,
  });
  if (!view.show) return null;

  const share = (n: number) => `${Math.min(100, Math.max(0, n * 100))}%`;
  /* The fill is what is left, so the bar drains as the credit is spent: the
     money is bought in and spent down, and what is worth watching is what has
     not gone yet. The session's slice is drawn inside that fill, at its
     right-hand end, as this conversation's share of what remains -- never wider
     than the fill, which is what the clamp is for. On a month bar, which has no
     top-up behind it, the fill stays the month consumed, as it always was. */
  const fill = view.onCredit ? view.leftShare : view.used;
  const ofFill = view.onCredit
    ? view.left > 0
      ? share(Math.min(1, session / view.left))
      : "0%"
    : view.used > 0
      ? share(view.slice / view.used)
      : "0%";
  const tone = view.over ? "is-over" : view.near ? "is-near" : "";

  /* What is left of the top-up, said first: the bar drains, and this is the
     figure worth having while typing. The month is deliberately not printed
     here any more -- what is left is the whole point of the bar, and the month,
     the ceiling and this conversation are one tap away in the card. */
  /* Whose till it is, when the bar is not the whole ledger's money. Somebody
     reading "$27.36 left of $30.00 credit" over a console that also pays
     another vendor has to be told which account that is. */
  const whose = chosen && !chosen.headline ? `${chosen.label}: ` : "";
  const consumed = view.onCredit
    ? `${whose}${money(view.left)} left of ${money(view.meter)} credit`
    : view.cap !== null
      ? `${money(ownMonth)} of ${money(view.cap)} this month`
      : `${money(ownMonth)} this month`;
  const mine = session > 0 ? ` · ${money(session)} this session` : "";
  const said = `${consumed}${mine}`;

  /* A phone hides .spend-words, and "15.58 30.00" without its words is not a
     sentence. Written out for that width instead: the two figures the fill
     stands for, as a division, with the session after it. */
  const short = view.onCredit || view.cap !== null
    ? `${money(view.onCredit ? view.left : ownMonth)}/${money(view.meter)}`
    : money(ownMonth);

  return (
    <>
      <button
      type="button"
      className={`spend ${tone}`.trim()}
      onClick={() => setOpen(true)}
      aria-label={`${said}. Open what this has cost.`}
      title={`${said}${view.over ? " — over the ceiling you set" : view.near ? " — close to the ceiling you set" : ""}. Open what this has cost.`}
    >
      {chosen && (
        <span className="spend-logos" aria-hidden="true">
          <VendorLogo provider={chosen.provider} size={12} />
        </span>
      )}
      <span className="spend-track" aria-hidden="true">
        <i
          className={`spend-used ${fill > 0 ? "is-any" : ""}`.trim()}
          style={{ width: share(fill) }}
        >
          <i
            className={`spend-mine ${view.slice > 0 ? "is-any" : ""}`.trim()}
            style={{ width: ofFill }}
          />
        </i>
      </span>
      <span className="spend-text">
        <span className="spend-long">{said}</span>
        <span className="spend-short">
          {short}
          {session > 0 && <> · {money(session)}</>}
        </span>
      </span>
    </button>
    {/* Beside the bar, not inside it: the card is a portal, so the DOM nesting
        is irrelevant, but React's events still follow the React tree -- a
        click on the card's backdrop would bubble up to the button that opened
        it and the card would close and reopen in the same click. */}
    {open && (
      <SpendPeek session={session} onUsage={onOpen} onClose={() => setOpen(false)} />
    )}
    </>
  );
});
