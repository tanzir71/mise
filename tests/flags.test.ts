import {expect,test} from 'vitest';
import {defaultFlags,flagEnabled,flagValue,type FeatureFlag} from '../packages/core/flags';

test('graduated flags remain enabled and unfinished features keep their default',()=>{for(const name of Object.keys(defaultFlags) as FeatureFlag[]){expect(flagEnabled(name)).toBe(defaultFlags[name]);expect(flagEnabled(name,'',JSON.stringify({[name]:false}))).toBe(defaultFlags[name]);expect(flagEnabled(name,'','null')).toBe(defaultFlags[name]);}});
test('isolated entries use the same exact opt-in semantics',()=>{for(const fallback of [true,false])for(const [query,stored,enabled] of [['','',fallback],['?flags=other,handOffs','',true],['','{"handOffs":true}',true],['','{"handOffs":"true"}',fallback],['','broken',fallback],['?flags=other','{"other":true}',fallback]] as const)expect(flagValue('handOffs',fallback,query,stored)).toBe(enabled);});
