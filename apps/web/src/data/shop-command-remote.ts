import {
  handoffBodyHeader,
  handoffBodyLimit,
} from '@mise/core/handoff-commands';
import { inboxBodyHeader, inboxBodyLimit } from '@mise/core/inbox-commands';
import { linkBodyHeader, linkBodyLimit } from '@mise/core/link-commands';
import {
  stockBatchBodyLimit,
  stockBatchHeader,
} from '@mise/core/stock-commands';
import {
  purchaseBodyHeader,
  purchaseBodyLimit,
} from '@mise/core/purchase-commands';
import { orderBodyHeader, orderBodyLimit } from '@mise/core/order-commands';
import {savedClosingParentHeader,validClosingParent} from '@mise/core/closing-source';
import {
  savedCurrencyHeader,
  validSavedCurrency,
} from '@mise/core/order-currency';
import {
  parseShopCommand,
  parseShopCommandReceipt,
  type ShopCommandReceipt,
} from '@mise/core/shop-commands';
import {
  createCommandRequest,
  bindCommandReceipt,
  CommandRequestError,
  type CommandAccount,
} from './command-request';
/** Runtime public configuration only. No token or command is persisted here. */
export function createShopCommandRemote(
  apiUrl: string,
  publishableKey: string,
  account: CommandAccount,
  send: typeof fetch = fetch,
) {
  let root: URL;
  try {
    root = new URL(apiUrl);
    if (
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      root.pathname !== '/' ||
      (root.protocol !== 'https:' &&
        !(
          root.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(root.hostname)
        )) ||
      !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)
    )
      throw Error();
  } catch {
    throw new Error('Cloud commands are not configured.');
  }
  const request = createCommandRequest(
    { apiUrl: root.origin, publishableKey },
    account,
    send,
  );
  return {
    async apply(
      value: unknown,
      currencyOrSignal?: string | AbortSignal,
      abort?: AbortSignal,
      closingParent?: string,
    ): Promise<ShopCommandReceipt> {
      const currency =
          typeof currencyOrSignal === 'string' ? currencyOrSignal : undefined,
        signal =
          typeof currencyOrSignal === 'string'
            ? abort
            : (currencyOrSignal ?? abort);
      if (currency !== undefined && !validSavedCurrency(currency))
        throw new CommandRequestError('review');
      // Serialize before asking for Auth: edits during refresh cannot alter this intent.
      const command = parseShopCommand(value),
        body = JSON.stringify(command),
        orderSave =
          command.type === 'order.create' || command.type === 'order.update',
        handoffSave =
          command.type === 'handoff.prepare' ||
          command.type === 'supplier-message.record',
        inboxSave = command.type === 'inbox.capture',
        linkSave = command.type === 'shopLink.generate';
      if(command.type==='closing.undo'?!validClosingParent(closingParent):closingParent!==undefined)throw new CommandRequestError('review');
      if (
        new TextEncoder().encode(body).byteLength >
        (command.type === 'stock.batch'
          ? stockBatchBodyLimit
          : command.type === 'purchase.record'
            ? purchaseBodyLimit
            : orderSave
              ? orderBodyLimit
              : handoffSave
                ? handoffBodyLimit
                : inboxSave
                  ? inboxBodyLimit
                  : linkSave
                    ? linkBodyLimit
                    : 32000)
      )
        throw new Error(
          'This reviewed change is too large. Shorten its text before sending.',
        );
      const responseValue = await request(
        body,
        {
          'Content-Type': 'application/json',
          ...(closingParent===undefined?{}:{[savedClosingParentHeader]:closingParent}),
          ...(currency === undefined
            ? {}
            : { [savedCurrencyHeader]: currency }),
          ...(command.type === 'stock.batch'
            ? { [stockBatchHeader]: command.outletId }
            : command.type === 'purchase.record'
              ? { [purchaseBodyHeader]: command.outletId }
              : orderSave
                ? { [orderBodyHeader]: command.outletId }
                : handoffSave
                  ? { [handoffBodyHeader]: command.outletId }
                  : inboxSave
                    ? { [inboxBodyHeader]: command.outletId }
                    : linkSave
                      ? { [linkBodyHeader]: command.outletId }
                      : {}),
        },
        command.type === 'stock.batch' ||
          orderSave ||
          handoffSave ||
          inboxSave ||
          linkSave
          ? 120000
          : command.type === 'purchase.record'
            ? 60000
            : 45000,
        signal,
      );
      try {
        return bindCommandReceipt(
          parseShopCommandReceipt(responseValue.value, command),
          responseValue.guard,
        );
      } catch {
        throw new CommandRequestError('retry');
      }
    },
  };
}
