// ==UserScript==
// @name         Double Ctrl Image Zoom for Floorp
// @namespace    https://github.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp
// @author       VcEnox
// @version      2.0
// @downloadURL  https://raw.githubusercontent.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp-/refs/heads/main/Double-Ctrl-Image-Zoom-for-Floorp.js
// @updateURL    https://raw.githubusercontent.com/VcEnox/Double-Ctrl-Image-Zoom-for-Floorp-/refs/heads/main/Double-Ctrl-Image-Zoom-for-Floorp.js
// @description  Pressing Ctrl twice on the image under the cursor zooms it to full screen; it supports zooming in and out with the mouse wheel and navigating by dragging.
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

   // Continuously track the mouse position
   //(since sites like last.fm may have invisible overlay or hover layers on top of images, using mouseover alone isn't sufficient)
    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }, { passive: true });

    // It scans all elements at the current mouse position 
    // (including overlapping ones) to find the actual image: first <img>, 
    // and if that’s not found, the layer using a background-image
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

    // Zoom/pan status
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

    // Double Ctrl detection
    document.addEventListener('keydown', (e) => {
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

        // Zoom with the mouse wheel
        overlay.addEventListener('wheel', onWheel, { passive: false });

        // Drag-to-navigate (only when zoom > 1)
        zoomedImg.addEventListener('mousedown', onDragStart);
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', onDragEnd);

        // Close when you click on the overlay (outside the image)
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) removeOverlay();
        });

        document.body.style.overflow = 'hidden';
        document.body.appendChild(overlay);
    }

    function onWheel(e) {
        e.preventDefault();

        const rect = zoomedImg.getBoundingClientRect();
        // The mouse cursor's position relative to the image (to set the zoom center relative to the cursor)
        const offsetX = e.clientX - rect.left - rect.width / 2;
        const offsetY = e.clientY - rect.top - rect.height / 2;

        const prevScale = scale;
        const delta = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale + delta * scale));

        // The “translate” setting to keep the cursor's position fixed
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
