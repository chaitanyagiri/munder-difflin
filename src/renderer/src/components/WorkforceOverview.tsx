import { CompanyChat } from './CompanyChat';

/** Company chat view: the conversation is the whole surface. The numbers live
 *  on the Trading Desk tab (components/trading/TradingDesk). */
export function WorkforceOverview() {
  return (
    <main aria-label="Company chat" className="md-dashboard">
      <div className="md-dashboard-inner">
        <section aria-label="Company chat" className="md-chat-pane">
          <CompanyChat />
        </section>
      </div>
    </main>
  );
}
