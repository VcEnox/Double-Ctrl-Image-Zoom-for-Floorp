// ==UserScript==
// @name         Double Ctrl Image Zoom for Floorp
// @namespace    https://github.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp
// @author       VcEnox
// @version      2.0
// @downloadURL  https://raw.githubusercontent.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp/refs/heads/main/Double-Ctrl-Image-Zoom-for-Floorp.js
// @updateURL    https://raw.githubusercontent.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp/refs/heads/main/Double-Ctrl-Image-Zoom-for-Floorp.js
// @description  Pressing Ctrl twice on the image under the cursor zooms it to full screen; it supports zooming in and out with the mouse wheel and navigating by dragging.
// @match        *://*/*
// @grant        none// ==UserScript==
// @name         Edge Tarzı Çift Ctrl Resim Büyütme (Zoom Destekli)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  İmlecin altındaki resme çift Ctrl basıldığında tam ekran büyütür, tekerlek ile yakınlaştırma/uzaklaştırma, sürükleyerek gezinme ve S ile anlamlı isimle PNG kaydetme destekler
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';
 
    let lastCtrlTime = 0;
    let overlay = null;
    let zoomedImg = null;
    let mouseX = 0;
    let mouseY = 0;
 
    const BG_URL_REGEX = /url\((['"]?)(.*?)\1\)/;
 
    // Continuously track the mouse position (since sites like last.fm may have 
    // invisible overlay/hover layers on top of img, a simple mouseover isn't enough)
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }, { passive: true });
 
    // It scans all elements at the current mouse position (including overlapping ones) to find 
    // the actual image: first the <img>, and if that isn't found, the layer using a background-image
    function findImageAtPoint(x, y) {
        const stack = typeof document.elementsFromPoint === 'function'
            ? document.elementsFromPoint(x, y)
            : [document.elementFromPoint(x, y)].filter(Boolean);
 
        // 1) Search directly for the <img> tag
        for (const el of stack) {
            if (el && el.tagName && el.tagName.toLowerCase() === 'img' && (el.currentSrc || el.src)) {
                return { type: 'img', src: el.currentSrc || el.src };
            }
        }
 
        // 2) Search for containers that contain a single <img> (e.g., link/span wrappers)
        for (const el of stack) {
            if (!el || !el.querySelector) continue;
            const innerImg = el.querySelector('img');
            if (innerImg && (innerImg.currentSrc || innerImg.src)) {
                return { type: 'img', src: innerImg.currentSrc || innerImg.src };
            }
        }
 
        // 3) Search for layers that use the CSS `background-image` property
        for (const el of stack) {
            if (!el) continue;
            const bg = getComputedStyle(el).backgroundImage;
            const match = bg && bg.match(BG_URL_REGEX);
            if (match && match[2]) {
                return { type: 'bg', src: match[2] };
            }
        }
 
        return null;
    }
 
    // Zoom/pan
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startTranslateX = 0;
    let startTranslateY = 0;
 
    const MIN_SCALE = 1;
    const MAX_SCALE = 8;
    const ZOOM_STEP = 0.15;
 
    // Dual Ctrl detection
    let savedScrollX = 0;
    let savedScrollY = 0;
    const SCROLL_KEYS = [' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
 
    document.addEventListener('keydown', (e) => {
        // Prevent the background page from scrolling with the keyboard while the overlay is open
        if (overlay && SCROLL_KEYS.includes(e.key)) {
            e.preventDefault();
            return;
        }
        if (e.key === 'Control') {
            if (e.repeat) return; // Ignore repeat events that occur when a key is held down
            const tag = document.activeElement && document.activeElement.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable)) {
                return;
            }
            const now = Date.now();
            if (now - lastCtrlTime < 350) {
                toggleZoom();
            }
            lastCtrlTime = now;
        } else if (e.key === 'Escape' && overlay) {
            removeOverlay();
        } else if (overlay && e.key && e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            savePng();
        }
    });
 
    function toggleZoom() {
        if (overlay) {
            removeOverlay();
            return;
        }
        const found = findImageAtPoint(mouseX, mouseY);
        if (!found) return;
 
        resetTransform();
 
        overlay = document.createElement('div');
        overlay.style = `
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(4px);
            display: flex; align-items: center; justify-content: center;
            z-index: 2147483647; cursor: zoom-in;
            overflow: hidden;
        `;
 
        // Click outside the overlay to close it
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) removeOverlay();
        });
 
        // Lock the page position (some sites can cause the position to shift when the DOM changes)
        savedScrollX = window.scrollX;
        savedScrollY = window.scrollY;
 
        // We do not alter `body.overflow` (this resets scrolling on sites such as Instagram).
        // Instead, we prevent the background from shifting by stopping events from occurring.
        overlay.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
        overlay.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
 
        document.documentElement.appendChild(overlay);
 
        buildZoomedElement(found.src);
    }
 
    const ZOOMED_STYLE = `
        max-width: 90vw; max-height: 90vh;
        object-fit: contain;
        border-radius: 6px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        transform-origin: center center;
        transition: transform 0.05s linear;
        user-select: none;
        will-change: transform;
    `;
 
    // It draws the image onto a canvas and displays it. This is the secret behind Edge 
    // generating a PNG file using “Save As”: when you right-click on the canvas in the browser to save it, 
    // the browser uses PNG—the canvas’s default format—rather than the original file format (WebP, AVIF, etc.).
    // Drawing on the canvas works even if the image comes from a different origin and is “tainted”; 
    // this only prevents the script from READING the pixels, but it does not block the browser’s native “Save As” menu.
    let currentPngBlob = null;
    let currentName = 'resim.png';
    let blobUrls = [];
 
    function gmFetchBlob(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'undefined') {
                reject(new Error('GM_xmlhttpRequest yok'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                headers: { Referer: location.href },
                onload: (r) => (r.status >= 200 && r.status < 300 && r.response)
                    ? resolve(r.response)
                    : reject(new Error('HTTP ' + r.status)),
                onerror: reject,
                ontimeout: reject
            });
        });
    }
 
    // First, try a normal fetch (same origin / data: / CORS permitted); if that doesn’t work, bypass CORS using GM
    async function fetchImageBlob(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return await res.blob();
        } catch (e) {
            return gmFetchBlob(url);
        }
    }
 
    // As this blob is from the same origin, the canvas will not be ‘tainted’, and toBlob will work
    async function toPngBlob(blob) {
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        return await new Promise((resolve, reject) => {
            canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob başarısız'))), 'image/png');
        });
    }
 
    function makeFileName(src) {
        const bad = /[\\/:*?"<>|\x00-\x1f]/g;
        let base = '';
        try {
            const u = new URL(src, location.href);
            if (u.protocol !== 'data:' && u.protocol !== 'blob:') {
                base = decodeURIComponent(u.pathname.split('/').pop() || '').replace(/\.[a-z0-9]{2,5}$/i, '');
            }
        } catch (e) {}
        base = base.replace(bad, '_').trim().slice(0, 80);
        if (base.length < 3) {
            const title = (document.title || 'resim').replace(bad, '_').trim().slice(0, 40);
            base = title + '-' + Date.now().toString(36);
        }
        return base + '.png';
    }
 
    function savePng() {
        if (!currentPngBlob) return;
        const a = document.createElement('a');
        const url = URL.createObjectURL(currentPngBlob);
        a.href = url;
        a.download = currentName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
 
    function addSaveButton() {
        const btn = document.createElement('button');
        btn.textContent = 'PNG olarak kaydet (S)';
        btn.style = `
            position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
            padding: 8px 14px; border: 0; border-radius: 6px;
            background: rgba(255,255,255,0.15); color: #fff;
            font: 13px sans-serif; cursor: pointer;
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            savePng();
        });
        overlay.appendChild(btn);
    }
 
    async function buildZoomedElement(src) {
        try {
            const pngBlob = await toPngBlob(await fetchImageBlob(src));
            if (!overlay) return; // Yüklenirken kapatılmış olabilir
            currentPngBlob = pngBlob;
            currentName = makeFileName(src);
            const url = URL.createObjectURL(pngBlob);
            blobUrls.push(url);
            const img = document.createElement('img');
            img.src = url;
            img.style = ZOOMED_STYLE;
            attachZoomedElement(img);
            addSaveButton();
        } catch (err) {
            if (overlay) buildCanvasFallback(src);
        }
    }
 
    // Fallback method: if the blob stream fails (e.g., SVG, blocked server), use the old canvas method. 
    // Right-clicking to save suggests the filename “canvas.png”; the S key does not work.
    function buildCanvasFallback(src) {
        const loader = new Image();
        loader.onload = () => {
            if (!overlay) return; // The overlay may have been closed whilst loading
            try {
                const canvas = document.createElement('canvas');
                canvas.width = loader.naturalWidth || loader.width;
                canvas.height = loader.naturalHeight || loader.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(loader, 0, 0);
                canvas.style = ZOOMED_STYLE;
                attachZoomedElement(canvas);
            } catch (err) {
                // In the event of an unexpected situation (e.g. a very large image), revert to the old <img> method
                attachZoomedElement(createFallbackImg(src));
            }
        };
        loader.onerror = () => {
            if (!overlay) return;
            attachZoomedElement(createFallbackImg(src));
        };
        loader.src = src;
    }
 
    function createFallbackImg(src) {
        const img = document.createElement('img');
        img.src = src;
        img.style = ZOOMED_STYLE;
        return img;
    }
 
    function attachZoomedElement(el) {
        zoomedImg = el;
        zoomedImg.draggable = false;
        overlay.appendChild(zoomedImg);
 
        overlay.addEventListener('wheel', onWheel, { passive: false });
        zoomedImg.addEventListener('mousedown', onDragStart);
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragEnd);
    }
 
    function onWheel(e) {
        e.preventDefault();
 
        const rect = zoomedImg.getBoundingClientRect();
        // The mouse pointer’s scale relative to the image (to adjust the zoom centre relative to the pointer)
        const offsetX = e.clientX - rect.left - rect.width / 2;
        const offsetY = e.clientY - rect.top - rect.height / 2;
 
        const prevScale = scale;
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta * scale));
 
        // The ‘translate’ setting to keep the cursor fixed at the point it is pointing to
        const scaleRatio = scale / prevScale;
        translateX = translateX * scaleRatio - offsetX * (scaleRatio - 1);
        translateY = translateY * scaleRatio - offsetY * (scaleRatio - 1);
 
        if (scale === MIN_SCALE) {
            translateX = 0;
            translateY = 0;
        }
 
        applyTransform();
        overlay.style.cursor = scale > MIN_SCALE ? 'grab' : 'zoom-in';
    }
 
    function onDragStart(e) {
        if (scale <= MIN_SCALE) return;
        e.preventDefault();
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        startTranslateX = translateX;
        startTranslateY = translateY;
        overlay.style.cursor = 'grabbing';
    }
 
    function onDragMove(e) {
        if (!isDragging) return;
        translateX = startTranslateX + (e.clientX - dragStartX);
        translateY = startTranslateY + (e.clientY - dragStartY);
        applyTransform();
    }
 
    function onDragEnd() {
        if (isDragging) {
            isDragging = false;
            if (overlay) overlay.style.cursor = scale > MIN_SCALE ? 'grab' : 'zoom-in';
        }
    }
 
    function applyTransform() {
        zoomedImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }
 
    function resetTransform() {
        scale = 1;
        translateX = 0;
        translateY = 0;
        isDragging = false;
    }
 
    function removeOverlay() {
        if (overlay) {
            overlay.removeEventListener('wheel', onWheel);
            window.removeEventListener('mousemove', onDragMove);
            window.removeEventListener('mouseup', onDragEnd);
            overlay.remove();
            overlay = null;
            zoomedImg = null;
            currentPngBlob = null;
            blobUrls.forEach((u) => URL.revokeObjectURL(u));
            blobUrls = [];
            resetTransform();
            // Safety net: if the site’s position has shifted, return it to its original position
            if (window.scrollX !== savedScrollX || window.scrollY !== savedScrollY) {
                window.scrollTo(savedScrollX, savedScrollY);
            }
        }
    }
})();
 
