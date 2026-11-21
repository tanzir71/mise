import {parseCustomerCommand,parseCustomerCommandReceipt,type CustomerCommand,type CustomerCommandReceipt} from './customer-commands';
import {parseCustomerResolutionReceipt,type CustomerResolutionReceipt} from './customer-review';
export type {CustomerCommand,CustomerCommandReceipt,CustomerRecordIds} from './customer-commands';
import {parseSupplierMessageCommand,parseSupplierMessageCommandReceipt,type SupplierMessageCommand,type SupplierMessageCommandReceipt} from './supplier-message-commands';
import {parseMoneyResolutionReceipt,type MoneyResolutionReceipt} from './money-review';
import {parsePurchaseResolutionReceipt,type PurchaseResolutionReceipt} from './purchase-review';
import {parseStockResolutionReceipt,type StockResolutionReceipt} from './stock-review';
import {parseClosingResolutionMetadata,type ClosingResolutionReceipt} from './closing-review';
import {parseCloudCommand,parseCloudCommandReceipt,type CloudCommand,type CloudCommandReceipt} from './cloud-commands';
import {isMoneyCommandType,parseMoneyCommand,parseMoneyCommandReceipt,type MoneyCommand,type MoneyCommandReceipt} from './money-commands';
import {isStockCommandType,parseStockCommand,parseStockCommandReceipt,type StockCommand,type StockCommandReceipt} from './stock-commands';
import {isPurchaseCommandType,parsePurchaseCommand,parsePurchaseCommandReceipt,type PurchaseCommand,type PurchaseCommandReceipt} from './purchase-commands';
import {isOrderCommandType,parseOrderCommand,parseOrderCommandReceipt,type OrderCommand,type OrderCommandReceipt} from './order-commands';
import {isClosingCommandType,parseClosingCommand,parseClosingCommandReceipt,type ClosingCommand,type ClosingCommandReceipt} from './closing-commands';
import {isHandoffCommandType,parseHandoffCommand,parseHandoffCommandReceipt,type HandoffCommand,type HandoffCommandReceipt} from './handoff-commands';
import {isInboxCommandType,parseInboxCommand,parseInboxCommandReceipt,type InboxCommand,type InboxCommandReceipt} from './inbox-commands';
import {isSettingsCommandType,parseSettingsCommand,parseSettingsCommandReceipt,type SettingsCommand,type SettingsCommandReceipt} from './settings-commands';
import {parseProfileCommand,parseProfileCommandReceipt,type ProfileCommand,type ProfileCommandReceipt} from './profile-commands';
import {isLinkCommandType,parseLinkCommand,parseLinkCommandReceipt,type LinkCommand,type LinkCommandReceipt} from './link-commands';
import {parseCommandResolutionReceipt,type CommandResolutionReceipt} from './command-resolution';
export type ShopCommand=CloudCommand|CustomerCommand|MoneyCommand|StockCommand|PurchaseCommand|OrderCommand|ClosingCommand|HandoffCommand|InboxCommand|SettingsCommand|ProfileCommand|LinkCommand|SupplierMessageCommand;
export type ShopCommandReceipt=CloudCommandReceipt|CustomerCommandReceipt|CustomerResolutionReceipt|MoneyCommandReceipt|StockCommandReceipt|PurchaseCommandReceipt|OrderCommandReceipt|ClosingCommandReceipt|ClosingResolutionReceipt|HandoffCommandReceipt|InboxCommandReceipt|SettingsCommandReceipt|ProfileCommandReceipt|LinkCommandReceipt|SupplierMessageCommandReceipt|CommandResolutionReceipt|MoneyResolutionReceipt|PurchaseResolutionReceipt|StockResolutionReceipt;
export function isSupplierMessageCommand(c:ShopCommand):c is SupplierMessageCommand{return c.type==='supplier-message.record';}
export function isLinkCommand(c:ShopCommand):c is LinkCommand{return isLinkCommandType(c.type);}
export function isProfileCommand(c:ShopCommand):c is ProfileCommand{return c.type==='setup.update';}
export function isSettingsCommand(c:ShopCommand):c is SettingsCommand{return isSettingsCommandType(c.type);}
export function isInboxCommand(c:ShopCommand):c is InboxCommand{return isInboxCommandType(c.type);}
export function isHandoffCommand(c:ShopCommand):c is HandoffCommand{return isHandoffCommandType(c.type);}
export function isClosingCommand(c:ShopCommand):c is ClosingCommand{return isClosingCommandType(c.type);}
export function isOrderCommand(c:ShopCommand):c is OrderCommand{return isOrderCommandType(c.type);}
export function isPurchaseCommand(c:ShopCommand):c is PurchaseCommand{return isPurchaseCommandType(c.type);}
export function isStockCommand(c:ShopCommand):c is StockCommand{return isStockCommandType(c.type);}
export function isMoneyCommand(c:ShopCommand):c is MoneyCommand {return isMoneyCommandType(c.type);}
const object=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
export function isCustomerCommand(c:ShopCommand):c is CustomerCommand {return c.type==='khata.settings'||c.type.startsWith('customer.');}
export function parseShopCommand(v:unknown):ShopCommand {
  if(object(v)&&v.type==='supplier-message.record')return parseSupplierMessageCommand(v);
  if(object(v)&&isLinkCommandType(v.type))return parseLinkCommand(v);
  if(object(v)&&v.type==='setup.update')return parseProfileCommand(v);
  if(object(v)&&isSettingsCommandType(v.type))return parseSettingsCommand(v);
  if(object(v)&&isInboxCommandType(v.type))return parseInboxCommand(v);
  if(object(v)&&isHandoffCommandType(v.type))return parseHandoffCommand(v);
  if(object(v)&&isClosingCommandType(v.type))return parseClosingCommand(v);
  if(object(v)&&isOrderCommandType(v.type))return parseOrderCommand(v);
  if(object(v)&&isPurchaseCommandType(v.type))return parsePurchaseCommand(v);
  if(object(v)&&isStockCommandType(v.type))return parseStockCommand(v);
  if(object(v)&&isMoneyCommandType(v.type))return parseMoneyCommand(v);
  if(!object(v)||typeof v.type!=='string'||(!v.type.startsWith('customer.')&&v.type!=='khata.settings'))return parseCloudCommand(v);
  return parseCustomerCommand(v);
}
export function parseShopCommandReceipt(v:unknown,c:ShopCommand):ShopCommandReceipt {
  if(object(v)&&v.type==='command.resolved'){
    if(isCustomerCommand(c))return parseCustomerResolutionReceipt(v,c);
    if(isMoneyCommand(c)&&c.type!=='khata.communication')return parseMoneyResolutionReceipt(v,c);
    if(isPurchaseCommand(c)&&'purchaseId'in c)return parsePurchaseResolutionReceipt(v,c);
    if(isStockCommand(c))return parseStockResolutionReceipt(v,c);
    if(isClosingCommand(c))return parseClosingResolutionMetadata(v,c);
    if(!isOrderCommand(c))throw new Error('This resolution does not match the original command family.');
    return parseCommandResolutionReceipt(v,c);
  }
  if(isSupplierMessageCommand(c))return parseSupplierMessageCommandReceipt(v,c);
  if(isLinkCommand(c))return parseLinkCommandReceipt(v,c);
  if(isProfileCommand(c))return parseProfileCommandReceipt(v,c);
  if(isSettingsCommand(c))return parseSettingsCommandReceipt(v,c);
  if(isInboxCommand(c))return parseInboxCommandReceipt(v,c);
  if(isHandoffCommand(c))return parseHandoffCommandReceipt(v,c);
  if(isClosingCommand(c))return parseClosingCommandReceipt(v,c);
  if(isOrderCommand(c))return parseOrderCommandReceipt(v,c);
  if(isPurchaseCommand(c))return parsePurchaseCommandReceipt(v,c);
  if(isStockCommand(c))return parseStockCommandReceipt(v,c);
  if(isMoneyCommand(c))return parseMoneyCommandReceipt(v,c);
  if(!isCustomerCommand(c))return parseCloudCommandReceipt(v,c);
  return parseCustomerCommandReceipt(v,c);
}
