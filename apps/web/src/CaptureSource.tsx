import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import type {SavedImageReview} from './data/image-capture';
import backAsset from './assets/inbox/back.svg';
import bellAsset from './assets/inbox/bell.svg';
export type ImageMode='invoice'|'list'|'prescription'|'screenshot';
export function useImageUrl(blob?:Blob){const [url,setUrl]=useState('');useEffect(()=>{if(!blob){setUrl('');return;}const next=URL.createObjectURL(blob);setUrl(next);return()=>URL.revokeObjectURL(next);},[blob]);return url;}
export function CaptureHeader({mode,title}:{mode:ImageMode;title?:string}){return <header className="capture-heading"><div><Link to={mode==='invoice'?'/stock':'/inbox'}><img src={backAsset} alt=""/>{mode==='invoice'?'Stock':'Inbox'}</Link><Link to="/inbox" aria-label="Open Inbox"><img src={bellAsset} alt=""/></Link></div><h1>{title??(mode==='invoice'?'Snap invoice':mode==='prescription'?'Read prescription':mode==='list'?'Read a list':'Read image')}</h1></header>;}
export function CapturePhoto({review,blob,caption='Original saved on this device'}:{review?:SavedImageReview;blob?:Blob;caption?:string}){const source=review?.image.blob??blob,url=useImageUrl(source);return <figure className="capture-photo">{url?<a href={url} target="_blank" rel="noreferrer" aria-label="Open full original image"><img src={url} alt={review?.image.name||'Selected original image'}/></a>:<span>Choose an image or use this device’s camera.</span>}<figcaption>{caption}</figcaption>{url&&review?<a className="capture-original-download" href={url} download={review.image.name}>Save original image</a>:null}</figure>;}
