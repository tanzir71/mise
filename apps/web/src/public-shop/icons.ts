import check from '@mise/ui/assets/public-shop/menu-check.svg?url';
import mic from '@mise/ui/assets/public-shop/corner-mic.svg?url';
import camera from '@mise/ui/assets/public-shop/corner-camera.svg?url';
import refresh from '@mise/ui/assets/public-shop/corner-refresh.svg?url';
import close from '@mise/ui/assets/public-shop/corner-close.svg?url';
import pin from '@mise/ui/assets/public-shop/pin.svg?url';
import send from '@mise/ui/assets/public-shop/corner-send.svg?url';
import minus from '@mise/ui/assets/public-shop/menu-minus.svg?url';
import plusLight from '@mise/ui/assets/public-shop/menu-plus-light.svg?url';
import plusDark from '@mise/ui/assets/public-shop/menu-plus-dark.svg?url';
import desktopMinus from '@mise/ui/assets/public-shop/desktop-minus.svg?url';
import desktopPlusLight from '@mise/ui/assets/public-shop/desktop-plus-light.svg?url';
import desktopPlusDark from '@mise/ui/assets/public-shop/desktop-plus-dark.svg?url';
import search from '@mise/ui/assets/public-shop/desktop-search.svg?url';
import clock from '@mise/ui/assets/public-shop/desktop-clock.svg?url';
import phone from '@mise/ui/assets/public-shop/desktop-phone.svg?url';
import {el} from './dom';
const assets={check,mic,camera,refresh,close,pin,send,minus,plusLight,plusDark,desktopMinus,desktopPlusLight,desktopPlusDark,search,clock,phone};
export function icon(name:keyof typeof assets):HTMLImageElement{return el('img',{src:assets[name],alt:'','aria-hidden':'true',class:'public-icon'});}
export function quantityIcon(name:'minus'|'plusLight'|'plusDark'):HTMLPictureElement{
  const desktop=name==='minus'?'desktopMinus':name==='plusLight'?'desktopPlusLight':'desktopPlusDark';return el('picture',{},el('source',{media:'(min-width:1024px)',srcset:assets[desktop]}),icon(name));
}
