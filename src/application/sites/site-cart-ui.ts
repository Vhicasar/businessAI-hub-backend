/**
 * The shopping cart a published website ships with.
 *
 * Kept out of the page renderer because it had outgrown being one line of it.
 * What changed, and why each part is the way it is:
 *
 *  - Quantities. The old cart could only add and remove, so a customer wanting
 *    three of something clicked "Add to cart" three times and then had no way
 *    back to two. It now has `−`/`+`, a count and a line total.
 *  - A stock ceiling that is real. `+` stops at what the warehouse actually
 *    has, read from the server rather than from anything the page was built
 *    with, because stock changes while a page sits open. The server checks it
 *    again when the order is created — this is courtesy, not security.
 *  - Checkout opens in its own tab, and the cart is kept. The old cart emptied
 *    itself the moment checkout was *started*, so a customer who changed their
 *    mind, lost connection, or simply came back to look again returned to an
 *    empty cart and a lost sale.
 *  - The cart empties only on a confirmed payment. The payment page is on the
 *    platform's origin, not the website's, so it cannot message this tab; the
 *    tab asks the server instead, and tells its sibling tabs over a
 *    BroadcastChannel.
 */

export function cartStyles(): string {
  return (
    '.cart-add{border:0;background:none;color:var(--primary);font:inherit;font-weight:750;padding:0 2px;cursor:pointer}'
    + '.cart-drawer{position:fixed;right:18px;bottom:18px;z-index:50;width:min(390px,calc(100% - 36px));max-height:min(82vh,760px);overflow:auto;padding:22px;background:var(--surface);color:var(--text);border-radius:var(--radius);box-shadow:0 24px 70px #0003;display:none}'
    + '.cart-drawer.open{display:block}'
    + '.cart-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}'
    + '.cart-items{display:grid;gap:14px;margin:16px 0}'
    + '.cart-item{display:grid;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--border)}'
    + '.cart-item:last-child{border-bottom:0;padding-bottom:0}'
    + '.cart-item-top{display:flex;justify-content:space-between;gap:12px;align-items:baseline}'
    + '.cart-item-name{font-weight:700}'
    + '.cart-item-line{color:var(--muted);font-size:13px;white-space:nowrap}'
    + '.cart-item-note{color:#b42318;font-size:13px}'
    + '.cart-qty{display:flex;align-items:center;gap:6px}'
    + '.cart-step{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--border);background:var(--background);color:var(--text);border-radius:8px;font:inherit;font-weight:750;cursor:pointer}'
    + '.cart-step:disabled{opacity:.42;cursor:not-allowed}'
    + '.cart-count{min-width:26px;text-align:center;font-weight:750;font-variant-numeric:tabular-nums}'
    + '.cart-remove{margin-left:auto;color:var(--muted);font-size:13px}'
    + '.cart-summary{display:grid;gap:6px;margin:14px 0;padding-top:12px;border-top:1px solid var(--border)}'
    /*
     * An explicit display rule beats the browser's own `[hidden]` rule, so a
     * summary declared `display:grid` stayed on screen when the cart emptied —
     * the subtotal of a cart that no longer had anything in it. Anything the
     * cart hides has to say so louder than its own layout does.
     */
    + '#cart [hidden]{display:none!important}'
    + '.cart-summary div{display:flex;justify-content:space-between;gap:12px}'
    + '.cart-total{font-weight:800;font-size:17px}'
    + '.cart-drawer input{width:100%;padding:11px;margin:5px 0;border:1px solid var(--border);background:var(--background);color:var(--text);border-radius:8px;font:inherit}'
    + '.cart-drawer .button[disabled]{opacity:.55;cursor:not-allowed}'
    + '#cart-message{margin:10px 0 0;font-size:13px;min-height:1.2em}'
    + '#cart-message.error{color:#b42318}'
    + '#cart-message.good{color:#067647}'
  );
}

export function cartMarkup(): string {
  return (
    '<aside id="cart" class="cart-drawer" aria-label="Shopping cart">'
    + '<div class="cart-head"><h2>Your cart</h2><button id="cart-close" class="cart-add" type="button">Close</button></div>'
    + '<div id="cart-items" class="cart-items"></div>'
    + '<div id="cart-summary" class="cart-summary" hidden></div>'
    + '<form id="checkout-form" hidden>'
    + '<input name="name" placeholder="Full name" required autocomplete="name"/>'
    + '<input name="email" type="email" required placeholder="Email" autocomplete="email"/>'
    + '<input name="phone" placeholder="Phone" autocomplete="tel"/>'
    + '<button class="button" type="submit" id="cart-submit">Continue to Checkout</button>'
    + '</form>'
    + '<p id="cart-message" role="status" aria-live="polite"></p>'
    + '</aside>'
  );
}

/**
 * The cart's behaviour.
 *
 * `preview` turns off every server call: a preview has no published site to
 * ask, its checkout is refused by design, and a cart that spent the preview
 * reporting failures would say nothing useful about the real one.
 */
export function cartScript(siteId: string, basePath: string, preview: boolean): string {
  const json = (value: unknown) => JSON.stringify(value);
  return `(function(){
var SITE=${json(siteId)},BASE=${json(basePath)},PREVIEW=${preview ? 'true' : 'false'};
var KEY='vh_cart_'+SITE,PENDING='vh_pending_order_'+SITE;
var cart=[],state={},pending=null,poll=null,polls=0;
function read(k,f){try{var v=localStorage.getItem(k);return v?JSON.parse(v):f}catch(e){return f}}
function write(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
function drop(k){try{localStorage.removeItem(k)}catch(e){}}
cart=read(KEY,[]);if(!Array.isArray(cart))cart=[];
pending=read(PENDING,null);
var drawer=document.getElementById('cart'),items=document.getElementById('cart-items'),
    summary=document.getElementById('cart-summary'),form=document.getElementById('checkout-form'),
    submit=document.getElementById('cart-submit'),message=document.getElementById('cart-message'),
    count=document.getElementById('cart-count');
var channel=null;try{channel=new BroadcastChannel(KEY)}catch(e){}
function say(text,kind){message.textContent=text||'';message.className=kind||''}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function money(amount,currency){
  try{return new Intl.NumberFormat(undefined,{style:'currency',currency:currency||'USD',maximumFractionDigits:2}).format(amount)}
  catch(e){return (currency||'')+' '+Number(amount).toLocaleString()}
}
function info(id){var s=state[id]||{};var local=cart.find(function(i){return i.variantId===id})||{};
  return{name:s.name||local.name||'Item',
         price:typeof s.unitPrice==='number'?s.unitPrice:(typeof local.price==='number'?local.price:0),
         currency:s.currency||local.currency||'',
         available:typeof s.available==='number'?s.available:null,
         reason:s.unavailableReason||null}}
function totals(){var sub=0,currency='';
  cart.forEach(function(i){var d=info(i.variantId);sub+=d.price*i.quantity;if(!currency)currency=d.currency});
  return{subtotal:Math.round(sub*100)/100,currency:currency}}
function draw(){
  write(KEY,cart);
  if(count)count.textContent=String(cart.reduce(function(s,i){return s+i.quantity},0));
  if(!cart.length){
    items.innerHTML='<p>Your cart is empty.</p>';
    /* Emptied as well as hidden: nothing stale is left to reappear if the
       drawer is reopened before the next draw. */
    summary.innerHTML='';summary.hidden=true;form.hidden=true;
    return;
  }
  items.innerHTML=cart.map(function(i){
    var d=info(i.variantId),atMax=d.available!==null&&i.quantity>=d.available;
    return '<div class="cart-item">'
      +'<div class="cart-item-top"><span class="cart-item-name">'+esc(d.name)+'</span>'
      +'<span class="cart-item-line">'+esc(money(d.price,d.currency))+' \\u00d7 '+i.quantity+' = '+esc(money(d.price*i.quantity,d.currency))+'</span></div>'
      +'<div class="cart-qty">'
      +'<button class="cart-step" type="button" data-dec="'+esc(i.variantId)+'" aria-label="Reduce quantity of '+esc(d.name)+'">\\u2212</button>'
      +'<span class="cart-count">'+i.quantity+'</span>'
      +'<button class="cart-step" type="button" data-inc="'+esc(i.variantId)+'" aria-label="Increase quantity of '+esc(d.name)+'"'+(atMax?' disabled':'')+'>+</button>'
      +'<button class="cart-add cart-remove" type="button" data-remove="'+esc(i.variantId)+'">Remove</button>'
      +'</div>'
      +(d.reason?'<p class="cart-item-note">'+esc(d.reason)+'</p>':'')
      +'</div>'}).join('');
  var t=totals();
  summary.hidden=false;
  summary.innerHTML='<div><span>Subtotal</span><span class="cart-total">'+esc(money(t.subtotal,t.currency))+'</span></div>'
    +'<div><span style="color:var(--muted);font-size:13px">Delivery and any taxes are shown at checkout.</span></div>';
  form.hidden=false;
  var blocked=cart.some(function(i){var d=info(i.variantId);return d.reason||(d.available!==null&&i.quantity>d.available)});
  submit.disabled=blocked;
}
/* Price and stock from the server. The cart shows what it has straight away
   and corrects itself when this answers, so it is never blank while waiting. */
async function refresh(){
  if(PREVIEW||!cart.length)return;
  try{
    var response=await fetch(BASE+'/cart',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({variantIds:cart.map(function(i){return i.variantId})})});
    if(!response.ok)return;
    var payload=await response.json();
    var lines=(payload&&payload.items)||[];
    state={};lines.forEach(function(line){state[line.variantId]=line});
    /* Clamp to what exists. Someone else may have bought it meanwhile, and a
       cart quietly holding six of the last one only fails later, at payment. */
    var trimmed=false;
    cart=cart.filter(function(i){
      var s=state[i.variantId];if(!s)return true;
      if(s.available<=0&&s.unavailableReason)return true;
      if(i.quantity>s.available&&s.available>0){i.quantity=s.available;trimmed=true}
      return true});
    draw();
    if(trimmed)say('Some quantities were reduced to match what is in stock.','error');
  }catch(e){/* Offline or blocked: the cart still works on what it knows. */}
}
function add(id,name,price,currency){
  var found=cart.find(function(i){return i.variantId===id});
  var s=state[id],ceiling=s&&typeof s.available==='number'?s.available:null;
  if(found){
    if(ceiling!==null&&found.quantity>=ceiling){say(ceiling===1?'Only 1 unit is available.':'Only '+ceiling+' units are available.','error');return}
    found.quantity++;
  }else{
    cart.push({variantId:id,name:name,quantity:1,price:price,currency:currency});
  }
  say('');draw();refresh();
}
document.querySelectorAll('.cart-add[data-variant]').forEach(function(button){
  button.addEventListener('click',function(){
    drawer.classList.add('open');
    add(button.dataset.variant,button.dataset.name,
        button.dataset.price!==undefined?Number(button.dataset.price):undefined,
        button.dataset.currency);
  });
});
items.addEventListener('click',function(event){
  var inc=event.target.closest('[data-inc]'),dec=event.target.closest('[data-dec]'),rm=event.target.closest('[data-remove]');
  if(inc){var d=info(inc.dataset.inc),row=cart.find(function(i){return i.variantId===inc.dataset.inc});
    if(!row)return;
    if(d.available!==null&&row.quantity>=d.available){say(d.available===1?'Only 1 unit is available.':'Only '+d.available+' units are available.','error');return}
    row.quantity++;say('');draw();return}
  if(dec){var r=cart.find(function(i){return i.variantId===dec.dataset.dec});if(!r)return;
    r.quantity--;if(r.quantity<1)cart=cart.filter(function(i){return i.variantId!==r.variantId});
    say('');draw();return}
  if(rm){cart=cart.filter(function(i){return i.variantId!==rm.dataset.remove});say('');draw()}
});
var toggle=document.getElementById('cart-toggle');
if(toggle)toggle.onclick=function(){drawer.classList.add('open');refresh()};
document.getElementById('cart-close').onclick=function(){drawer.classList.remove('open')};
/* A confirmed payment is the only thing that empties the cart. */
function settled(){
  cart=[];state={};pending=null;drop(PENDING);stopPolling();draw();
  say('Payment received \\u2014 thank you. Your receipt is on its way by email.','good');
  if(channel)try{channel.postMessage({type:'paid'})}catch(e){}
}
function stopPolling(){if(poll){clearInterval(poll);poll=null}}
async function checkOrder(){
  if(PREVIEW||!pending||!pending.orderId)return;
  polls++;
  if(polls>240){stopPolling();return}
  try{
    var response=await fetch(BASE+'/order-status?order='+encodeURIComponent(pending.orderId),{headers:{accept:'application/json'}});
    if(!response.ok){if(response.status===404){pending=null;drop(PENDING);stopPolling()}return}
    var payload=await response.json();
    if(payload&&payload.paid)settled();
    else if(payload&&payload.cancelled){pending=null;drop(PENDING);stopPolling()}
  }catch(e){}
}
function watchOrder(){
  stopPolling();
  if(PREVIEW||!pending)return;
  polls=0;
  poll=setInterval(checkOrder,5000);
  checkOrder();
}
/* The customer coming back to this tab is the usual moment a payment finished. */
document.addEventListener('visibilitychange',function(){if(!document.hidden&&pending)checkOrder()});
window.addEventListener('focus',function(){if(pending)checkOrder()});
if(channel)channel.onmessage=function(event){
  if(event&&event.data&&event.data.type==='paid'){cart=[];state={};pending=null;drop(PENDING);stopPolling();draw()}
};
/* Another tab of this site changing the cart, for browsers without BroadcastChannel. */
window.addEventListener('storage',function(event){
  if(event.key===KEY){cart=read(KEY,[]);if(!Array.isArray(cart))cart=[];draw()}
  if(event.key===PENDING&&!event.newValue){pending=null;stopPolling()}
});
form.onsubmit=async function(event){
  event.preventDefault();
  if(!cart.length)return;
  var data=new FormData(event.target);
  submit.disabled=true;
  say('Preparing secure payment\\u2026');
  try{
    var response=await fetch(BASE+'/checkout',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name:data.get('name'),email:data.get('email'),phone:data.get('phone'),
        items:cart.map(function(i){return{variantId:i.variantId,quantity:i.quantity}})})});
    var payload=await response.json();
    if(!response.ok){
      say((payload&&payload.error&&(payload.error.message||payload.error))||'Checkout could not be started.','error');
      submit.disabled=false;refresh();return;
    }
    /* Remembered, not emptied. The cart is still the customer's until the
       payment is confirmed; a closed payment tab must leave it intact. */
    pending={orderId:payload.orderId,at:Date.now()};
    write(PENDING,pending);
    var opened=window.open(payload.url,'_blank','noopener,noreferrer');
    if(!opened){
      /* A blocked popup must not strand the customer: give them the link. */
      say('Your browser blocked the payment tab. ','error');
      var link=document.createElement('a');
      link.href=payload.url;link.target='_blank';link.rel='noopener noreferrer';
      link.textContent='Open secure payment';link.className='cart-add';
      message.appendChild(link);
    }else{
      say('Payment opened in a new tab. Your cart is kept here until the payment is confirmed.');
    }
    submit.disabled=false;
    watchOrder();
  }catch(e){
    say('Checkout could not be started. Please check your connection and try again.','error');
    submit.disabled=false;
  }
};
draw();
if(pending)watchOrder();
refresh();
})();`.replace(/\n\s*/g, '');
}
