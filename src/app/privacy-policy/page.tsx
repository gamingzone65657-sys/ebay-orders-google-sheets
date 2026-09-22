import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { PRIVACY_POLICY_LAST_UPDATED, legalContact } from "@/lib/legal";

/**
 * Public privacy policy.
 *
 * Deliberately outside the (app) route group: that group's layout calls
 * getCurrentUser(), which refuses in production unless single-user mode is on.
 * A privacy policy that only a logged-in operator can read is useless — eBay
 * and Google both require it to be reachable by anyone, including their own
 * review tooling. This page therefore uses only the root layout, reads no
 * session, and touches no database.
 *
 * Everything below describes what this application actually does. It was
 * written against the real data flow — the connection tables, the order
 * importer, the sheet writer and the retention settings — not from a
 * template.
 */

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How this application handles eBay and Google account authorization, order data, and spreadsheet access.",
};

// Static: the page has no per-request content, so it is served from the edge
// cache and cannot be affected by a database or credential problem.
export const dynamic = "force-static";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="mt-10 mb-3 text-lg font-semibold text-foreground sm:text-xl">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground sm:text-[15px]">
        {children}
      </div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="ml-1 space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5">
          <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PrivacyPolicyPage() {
  const { operator, email, appUrl } = legalContact();
  const policyUrl = appUrl ? `${appUrl}/privacy-policy` : "/privacy-policy";

  const contactLine = email ? (
    <>
      Email{" "}
      <a
        href={`mailto:${email}?subject=Privacy%20request`}
        className="font-medium text-link underline underline-offset-2"
      >
        {email}
      </a>
      .
    </>
  ) : (
    <>
      A contact address has not been configured for this deployment. If you
      reached this page from an application you use, contact the person or
      business who gave you access to it — they operate this installation and
      control the data it holds.
    </>
  );

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <header className="border-b border-border pb-6">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          eBay Orders → Google Sheets
        </p>
        <h1 className="mt-2 text-2xl font-bold text-foreground sm:text-3xl">
          Privacy Policy
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Last updated {PRIVACY_POLICY_LAST_UPDATED}
        </p>
      </header>

      <div className="mt-8 rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground sm:p-5">
        <p>
          This application imports orders from a seller&apos;s own eBay account
          and writes them into a Google Sheet that the same seller chooses. It
          exists to move that seller&apos;s data between two services they
          already use. It is not an advertising product, it builds no profiles,
          and it has nothing to sell.
        </p>
      </div>

      <Section id="who-we-are" title="1. Who this policy covers">
        <p>
          This policy describes the installation of this application served at{" "}
          <span className="font-mono text-xs text-foreground">{policyUrl}</span>
          , operated by {operator}.
        </p>
        <p>
          The application is used by a <strong>seller</strong> — the person who
          connects their own eBay and Google accounts to it. Where this policy
          says &ldquo;you&rdquo;, it means that seller. Information about eBay{" "}
          <strong>buyers</strong> is also described below, because an order
          necessarily contains it.
        </p>
      </Section>

      <Section id="what-we-collect" title="2. What information is processed">
        <p>The application handles four kinds of information.</p>

        <h3 className="pt-2 font-medium text-foreground">
          a. Account authorization data
        </h3>
        <Bullets
          items={[
            <>
              <strong>eBay</strong>: an access token and a refresh token issued
              by eBay after you approve the connection, the scopes eBay granted,
              your eBay user ID and username, and the marketplace you sell on.
            </>,
            <>
              <strong>Google</strong>: an access token and a refresh token issued
              by Google, the scopes granted, and the email address, display name
              and profile picture of the connected Google account.
            </>,
            <>
              The application <strong>never receives or stores your eBay or
              Google password</strong>. Sign-in happens on eBay&apos;s and
              Google&apos;s own pages.
            </>,
          ]}
        />

        <h3 className="pt-2 font-medium text-foreground">b. eBay order data</h3>
        <p>
          When a synchronization runs, the application retrieves orders from your
          eBay account through eBay&apos;s official APIs. Depending on what eBay
          returns for your account and marketplace, an order can include:
        </p>
        <Bullets
          items={[
            "order identifiers, dates, status, and the marketplace it was placed on",
            "line items: SKU, title, quantity, unit price, variation and per-line totals",
            "order totals, subtotal, shipping cost, tax, discounts and currency",
            "fulfilment and shipment details, including tracking numbers and carrier",
            <>
              <strong>buyer information</strong>: username, name, and where eBay
              provides it, the shipping address, email address and phone number
            </>,
          ]}
        />
        <p>
          The complete response eBay returned for each order is also stored, so
          that a field mapping added later can be applied to orders already
          imported without re-fetching them.
        </p>

        <h3 className="pt-2 font-medium text-foreground">
          c. Google Sheets data
        </h3>
        <Bullets
          items={[
            "the names and identifiers of spreadsheets in your Google Drive, so you can pick one",
            "the worksheet names and grid dimensions of the spreadsheet you select",
            "the header row of the worksheet you select, so columns can be offered as mapping targets",
            "the values in the one column you nominate as the key column, read to determine whether an order is already present",
          ]}
        />

        <h3 className="pt-2 font-medium text-foreground">
          d. Application data
        </h3>
        <Bullets
          items={[
            "your field mappings, filters, rules, saved configurations and schedule settings",
            "a record of each synchronization run: when it ran, how long it took, how many rows were inserted, updated, skipped or failed, and any error",
            "a log of requests made to eBay and Google — the operation name, status code, duration and any error category, but never request or response bodies",
          ]}
        />
      </Section>

      <Section id="authorization" title="3. How eBay and Google authorization works">
        <p>
          Both connections use the providers&apos; own OAuth 2.0 flows. When you
          connect an account you are sent to eBay&apos;s or Google&apos;s sign-in
          and consent page, where you see exactly which permissions are being
          requested. Your credentials are entered on their site, not this one.
        </p>
        <p>
          If you approve, the provider returns an authorization code to this
          application&apos;s server, which exchanges it for tokens. Those tokens
          are encrypted before being stored and are used only to make the API
          calls described in this policy.
        </p>
        <p>
          <strong>Google permissions.</strong> The application requests the
          ability to list your spreadsheet files and to read and write
          spreadsheets. It uses that access solely for the spreadsheet you
          select. It does not read the contents of other files in your Drive.
        </p>
        <p>
          <strong>eBay permissions.</strong> The application requests read access
          to your order fulfilment data, and optionally your basic account
          identity so your seller username can be displayed. It does not list
          items, change prices, or take any action on your eBay account.
        </p>
      </Section>

      <Section id="how-used" title="4. How the information is used">
        <p>
          Everything the application processes is used for one purpose: importing
          your eBay orders and writing them into the spreadsheet you chose, in
          the layout you configured.
        </p>
        <Bullets
          items={[
            "Order data is transformed according to your field mappings and written to the columns you mapped.",
            "The key column is read from your sheet before each write so an order already present is updated in place rather than added a second time.",
            "Synchronization records let you see what happened in each run and retry an individual order that failed.",
            "Connection status and token expiry are tracked so the application can tell you when an account needs reconnecting.",
          ]}
        />
        <p>
          The information is <strong>not</strong> used for advertising, profiling,
          training machine-learning models, or any purpose unrelated to producing
          your spreadsheet.
        </p>
      </Section>

      <Section id="sheets-access" title="5. What is written to your Google Sheet">
        <p>
          The application writes <strong>only</strong> to the columns you
          explicitly mapped, in the worksheet you selected. Columns you did not
          map are never modified, even when they sit between two columns that
          were.
        </p>
        <p>By design, the application never:</p>
        <Bullets
          items={[
            "deletes a row, clears a worksheet, or removes a column",
            "writes outside the worksheet you selected",
            "modifies any other spreadsheet in your Drive",
          ]}
        />
        <p>
          Before the first bulk write into a new destination, the application
          shows a preview of exactly which rows and columns would change and
          waits for your confirmation.
        </p>
      </Section>

      <Section id="sharing" title="6. Who the information is shared with">
        <p className="font-medium text-foreground">
          This application does not sell your personal information, and does not
          sell the personal information of any buyer whose order it processes.
        </p>
        <p>
          It is also not shared with advertisers, data brokers, or any third
          party for their own purposes. Information leaves this application only
          in these ways:
        </p>
        <Bullets
          items={[
            <>
              <strong>eBay</strong> — requests are made to eBay&apos;s official
              APIs to retrieve your orders.
            </>,
            <>
              <strong>Google</strong> — requests are made to the Google Drive and
              Google Sheets APIs to list your spreadsheets and write your orders
              into the one you selected.
            </>,
            <>
              <strong>Hosting and database providers</strong> — the application
              runs on hosting infrastructure and stores data in a database
              operated by the hosting or database provider chosen by the
              operator of this installation.
            </>,
          ]}
        />
        <p>
          Your use of eBay and Google remains governed by their own privacy
          policies.
        </p>
      </Section>

      <Section id="security" title="7. Storage and security">
        <Bullets
          items={[
            <>
              eBay and Google tokens are <strong>encrypted at rest</strong> using
              AES-256-GCM before being written to the database. They are never
              returned by the application&apos;s interface and never sent to the
              browser.
            </>,
            "All communication with eBay and Google uses HTTPS.",
            "Buyer contact details are masked in the interface by default and are only shown in full when explicitly revealed.",
            "Logs record the operation, status and duration of API calls. Tokens, secrets and credential-shaped values are removed before anything is written to a log.",
            "State-changing requests are protected against cross-site request forgery, and requests are rate limited.",
          ]}
        />
        <p>
          No system can be guaranteed perfectly secure, but the measures above
          are implemented and enforced in the application&apos;s code rather than
          described as an intention.
        </p>
      </Section>

      <Section id="retention" title="8. How long information is kept">
        <Bullets
          items={[
            "Orders, synchronization history and your configuration are kept until you delete them or the operator removes the installation.",
            "The complete eBay response stored for each order — the record containing the most buyer detail — can be cleared automatically after a configurable period, keeping the order itself intact.",
            "Synchronization logs and per-order results can likewise be removed automatically after a configurable period.",
            "Disconnecting an account deletes its stored tokens immediately. Orders already imported are kept so your spreadsheet history remains explainable, unless you ask for them to be deleted.",
          ]}
        />
      </Section>

      <Section id="your-rights" title="9. Your choices and rights">
        <p>You can, at any time and without contacting anyone:</p>
        <Bullets
          items={[
            <>
              <strong>Revoke access</strong> — disconnect eBay or Google from the
              application&apos;s settings page, which deletes the stored tokens.
              You can also revoke access directly at{" "}
              <a
                href="https://myaccount.google.com/permissions"
                className="text-link underline underline-offset-2"
                target="_blank"
                rel="noreferrer noopener"
              >
                your Google account permissions
              </a>{" "}
              or in your eBay account settings.
            </>,
            "Stop automatic synchronization, or change how far back it looks.",
            "Change or remove any field mapping, so a category of data stops being written to your sheet.",
          ]}
        />
        <p>
          Depending on where you live, you may also have the right to request a
          copy of the information held about you, to have it corrected, to have
          it deleted, or to object to its processing. To make any of those
          requests, use the contact details in section 11.
        </p>
        <p>
          <strong>Buyers:</strong> if you bought from a seller who uses this
          application and want your information removed from their records,
          contact the seller directly — they control the installation and the
          spreadsheet. The contact in section 11 can help with the copy held by
          this application.
        </p>
      </Section>

      <Section id="ebay-deletion" title="10. eBay account deletion notifications">
        <p>
          This application implements eBay&apos;s Marketplace Account
          Deletion/Closure notification endpoint. When an eBay user closes their
          account, eBay notifies this application so that the corresponding
          information can be handled according to eBay&apos;s requirements.
        </p>
        <p>
          The endpoint is served at{" "}
          <span className="font-mono text-xs break-all text-foreground">
            {appUrl
              ? `${appUrl}/api/ebay/marketplace-account-deletion`
              : "/api/ebay/marketplace-account-deletion"}
          </span>
          .
        </p>
      </Section>

      <Section id="contact" title="11. Contact">
        <p>For any privacy question or data request: {contactLine}</p>
        <p>
          Please say clearly what you are asking for, so the request can be dealt
          with properly.
        </p>
      </Section>

      <Section id="changes" title="12. Changes to this policy">
        <p>
          If this policy changes in a way that affects what is collected or how
          it is used, the date at the top of this page is updated. Material
          changes will be reflected here before they take effect.
        </p>
      </Section>

      <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-sm">
        <Link href="/dashboard" className="text-link underline underline-offset-2">
          Back to the application
        </Link>
        <p className="text-xs text-muted-foreground">
          Last updated {PRIVACY_POLICY_LAST_UPDATED}
        </p>
      </footer>
    </main>
  );
}
