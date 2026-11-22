import {
  parseCloudConnection,
  type CloudConnection,
} from '@mise/core/cloud-connection';
import {
  customerLinkId,
  parseCustomerLinkAttempt,
  parseCustomerLinkIssued,
  parseCustomerLinkMetadata,
  parseCustomerLinkPage,
  parseCustomerLinkScope,
  parseCustomerLinkSource,
  type CustomerLinkScope,
  type CustomerLinkSource,
} from '@mise/core/customer-link-admin';
import {
  bindCommandReceipt,
  CommandRequestError,
  createCustomerLinkRequest,
  type CommandAccount,
  type CustomerLinkRpc,
} from './command-request';

export function createCustomerLinkRemote(
  input: CloudConnection,
  account: CommandAccount,
  selected: CustomerLinkScope,
  send: typeof fetch = fetch,
) {
  const config = parseCloudConnection(input),
    scope = parseCustomerLinkScope(selected),
    requests = new Map<
      CustomerLinkRpc,
      ReturnType<typeof createCustomerLinkRequest>
    >();
  async function call<T extends object>(
    rpc: CustomerLinkRpc,
    body: Record<string, unknown>,
    parse: (v: unknown) => T,
    signal?: AbortSignal,
  ) {
    let request = requests.get(rpc);
    if (!request) {
      request = createCustomerLinkRequest(config, account, rpc, send);
      requests.set(rpc, request);
    }
    const response = await request(
      JSON.stringify(body),
      { 'Content-Type': 'application/json' },
      30000,
      signal,
    );
    response.guard();
    let value: T;
    try {
      value = parse(response.value);
    } catch {
      throw new CommandRequestError('review');
    }
    response.guard();
    return bindCommandReceipt(value, response.guard);
  }
  const source = (value: CustomerLinkSource) =>
    parseCustomerLinkSource(value, scope);
  return {
    page(after: string | null = null, limit = 50, signal?: AbortSignal) {
      if (
        (after !== null && !customerLinkId(after)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        throw new CommandRequestError('review');
      return call(
        'read_customer_link_page',
        {
          p_kind: scope.kind,
          p_resource_id: scope.resourceId,
          p_after_id: after,
          p_page_size: limit,
        },
        (v) => parseCustomerLinkPage(v, scope, after, limit),
        signal,
      );
    },
    create(value: CustomerLinkSource, signal?: AbortSignal) {
      const s = source(value);
      return call(
        'create_public_link',
        {
          p_id: s.id,
          p_event_id: s.createEventId,
          p_kind: s.kind,
          p_resource_id: s.resourceId,
          p_expires_at: s.expiresAt,
        },
        (v) => parseCustomerLinkIssued(v, s),
        signal,
      );
    },
    inspect(value: CustomerLinkSource, signal?: AbortSignal) {
      const s = source(value);
      return call(
        'read_public_link_attempt',
        {
          p_id: s.id,
          p_create_event_id: s.createEventId,
          p_kind: s.kind,
          p_resource_id: s.resourceId,
        },
        (v) => parseCustomerLinkAttempt(v, s),
        signal,
      );
    },
    close(value: CustomerLinkSource, eventId: string, signal?: AbortSignal) {
      const s = source(value);
      if (!customerLinkId(eventId) || [s.id, s.createEventId].includes(eventId))
        throw new CommandRequestError('review');
      return call(
        'close_public_link_attempt',
        {
          p_id: s.id,
          p_create_event_id: s.createEventId,
          p_event_id: eventId,
          p_kind: s.kind,
          p_resource_id: s.resourceId,
        },
        (v) => {
          const result = parseCustomerLinkAttempt(v, s);
          if (result.state !== 'closed')
            throw new CommandRequestError('review');
          return result;
        },
        signal,
      );
    },
    revoke(id: string, eventId: string, signal?: AbortSignal) {
      if (!customerLinkId(id) || !customerLinkId(eventId) || id === eventId)
        throw new CommandRequestError('review');
      return call(
        'revoke_public_link',
        { p_id: id, p_event_id: eventId },
        (v) => {
          const link = parseCustomerLinkMetadata(v, scope);
          if (link.id !== id || link.revokedAt === null)
            throw new CommandRequestError('review');
          return link;
        },
        signal,
      );
    },
  };
}
