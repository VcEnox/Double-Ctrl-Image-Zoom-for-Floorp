// ==UserScript==
// @name         Edge Tarzı Çift Ctrl Resim Büyütme (Zoom Destekli)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  İmlecin altındaki resme çift Ctrl basıldığında tam ekran büyütür, tekerlek ile yakınlaştırma/uzaklaştırma ve sürükleyerek gezinme destekler
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    let lastCtrlTime = 0;
    let overlay = null;
    let zoomedImg = null;
    let mouseX = 0;
    let mouseY = 0;

    const BG_URL_REGEX = /url\((['"]?)(.*?)\1\)/;

    // Fare pozisyonunu sürekli takip et (last.fm gibi sitelerde imgin üstünde
    // görünmez overlay/hover katmanları olabildiği için mouseover yetersiz kalıyor)
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }, { passive: true });

    // O anki fare konumundaki tüm elementleri (üst üste binenler dahil) tarayıp
    // gerçek görseli bulur: önce <img>, olmazsa background-image kullanan katman
    function findImageAtPoint(x, y) {
        const stack = typeof document.elementsFromPoint === 'function'
            ? document.elementsFromPoint(x, y)
            : [document.elementFromPoint(x, y)].filter(Boolean);

        // 1) Doğrudan <img> etiketi ara
        for (const el of stack) {
            if (el && el.tagName && el.tagName.toLowerCase() === 'img' && (el.currentSrc || el.src)) {
                return { type: 'img', src: el.currentSrc || el.src };
            }
        }

        // 2) İçinde tek bir <img> barındıran kapsayıcıları ara (ör. link/span sarmalı)
        for (const el of stack) {
            if (!el || !el.querySelector) continue;
            const innerImg = el.querySelector('img');
            if (innerImg && (innerImg.currentSrc || innerImg.src)) {
                return { type: 'img', src: innerImg.currentSrc || innerImg.src };
            }
        }

        // 3) CSS background-image kullanan katmanları ara
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

    // Zoom/pan durumu
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

    // Çift Ctrl algılama
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Control') {
            if (e.repeat) return; // Tuş basılı tutulunca gelen tekrar olaylarını yok say
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

        zoomedImg = document.createElement('img');
        zoomedImg.src = found.src;
        zoomedImg.draggable = false;
        zoomedImg.style = `
            max-width: 90vw; max-height: 90vh;
            object-fit: contain;
            border-radius: 6px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            transform-origin: center center;
            transition: transform 0.05s linear;
            user-select: none;
            will-change: transform;
        `;

        overlay.appendChild(zoomedImg);

        // Tekerlek ile zoom
        overlay.addEventListener('wheel', onWheel, { passive: false });

        // Sürükleyerek gezinme (sadece zoom > 1 iken)
        zoomedImg.addEventListener('mousedown', onDragStart);
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragEnd);

        // Overlay'e (resmin dışına) tıklayınca kapat
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) removeOverlay();
        });

        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
    }

    function onWheel(e) {
        e.preventDefault();

        const rect = zoomedImg.getBoundingClientRect();
        // Fare imlecinin resim üzerindeki oranı (zoom merkezini imlece göre ayarlamak için)
        const offsetX = e.clientX - rect.left - rect.width / 2;
        const offsetY = e.clientY - rect.top - rect.height / 2;

        const prevScale = scale;
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta * scale));

        // İmlecin işaret ettiği noktayı sabit tutmak için translate ayarı
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
            document.body.style.overflow = '';
            resetTransform();
        }
    }
})();
