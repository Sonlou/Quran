// PDF.js integration and app functionality
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url).href;

class QuranPDFViewer {
    constructor() {
        this.pdf = null;
        this.currentPage = 1;
        this.totalPages = 0;
        this.zoomLevel = 1.0;
        this.minZoom = 0.5;
        this.maxZoom = 3.0;
        this.renderedPages = new Map();
        this.visiblePages = new Set();
        this.isDarkTheme = false;
        
        // Touch and gesture handling
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.isSwipeGesture = false;
        
        // Performance optimization
        this.renderBuffer = 2; // Pages to render ahead/behind
        this.renderQueue = [];
        this.isRendering = false;
        
        this.initializeApp();
    }
    
    async initializeApp() {
        this.setupEventListeners();
        this.initializeSurahNavigation();
        this.loadTheme();
        
        // Load default PDF or wait for user to upload
        await this.loadDefaultPDF();
    }
    
    setupEventListeners() {
        // Navigation controls
        document.getElementById('prev-page').addEventListener('click', () => this.previousPage());
        document.getElementById('next-page').addEventListener('click', () => this.nextPage());
        
        // Zoom controls
        document.getElementById('zoom-in').addEventListener('click', () => this.zoomIn());
        document.getElementById('zoom-out').addEventListener('click', () => this.zoomOut());
        document.getElementById('zoom-fit').addEventListener('click', () => this.fitToWidth());
        
        // Theme toggle
        document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());
        
        // Surah navigation
        document.getElementById('surah-nav-btn').addEventListener('click', () => this.toggleSurahPanel());
        document.getElementById('close-surah-panel').addEventListener('click', () => this.closeSurahPanel());
        
        // Search functionality
        document.getElementById('surah-search').addEventListener('input', (e) => this.filterSurahs(e.target.value));
        
        // Retry button
        document.getElementById('retry-btn').addEventListener('click', () => this.loadDefaultPDF());
        
        // Keyboard navigation
        document.addEventListener('keydown', (e) => this.handleKeyboardNavigation(e));
        
        // Scroll handling for page updates
        const pagesContainer = document.getElementById('pages-container');
        pagesContainer.addEventListener('scroll', () => this.updateVisiblePages());
        
        // Touch events for mobile
        pagesContainer.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: true });
        pagesContainer.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: true });
        pagesContainer.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        
        // Window resize
        window.addEventListener('resize', () => this.handleResize());
        
        // Prevent context menu on PDF pages
        pagesContainer.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    
    async loadDefaultPDF() {
        try {
            this.showLoading();
            
            // Local PDF file path - place your PDF in the public folder
            const pdfUrl = '/am_Translation_of_Amharic_Quran.pdf';
            
            const loadingTask = pdfjsLib.getDocument({
                url: pdfUrl,
                cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
                cMapPacked: true,
            });
            
            this.pdf = await loadingTask.promise;
            this.totalPages = this.pdf.numPages;
            
            this.updatePageInfo();
            this.hideLoading();
            
            await this.renderInitialPages();
            
            console.log(`PDF loaded successfully: ${this.totalPages} pages`);
            
        } catch (error) {
            console.error('Error loading PDF:', error);
            this.showError();
        }
    }
    
    async renderInitialPages() {
        const pagesContainer = document.getElementById('pages-container');
        pagesContainer.innerHTML = '';
        
        // Create placeholder elements for all pages
        for (let i = 1; i <= this.totalPages; i++) {
            const pageWrapper = document.createElement('div');
            pageWrapper.className = 'page-wrapper';
            pageWrapper.dataset.pageNumber = i;
            
            const canvas = document.createElement('canvas');
            canvas.className = 'pdf-page';
            canvas.style.display = 'none';
            
            pageWrapper.appendChild(canvas);
            pagesContainer.appendChild(pageWrapper);
        }
        
        // Render initial visible pages
        await this.renderVisiblePages();
        this.updateVisiblePages();
    }
    
    async renderPage(pageNum) {
        if (this.renderedPages.has(pageNum) || !this.pdf) return;
        
        try {
            const page = await this.pdf.getPage(pageNum);
            const canvas = document.querySelector(`[data-page-number="${pageNum}"] canvas`);
            
            if (!canvas) return;
            
            const context = canvas.getContext('2d');
            const viewport = page.getViewport({ scale: this.zoomLevel });
            
            // Set canvas dimensions
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.width = viewport.width + 'px';
            canvas.style.height = viewport.height + 'px';
            
            // Render page
            const renderContext = {
                canvasContext: context,
                viewport: viewport,
            };
            
            await page.render(renderContext).promise;
            
            canvas.style.display = 'block';
            this.renderedPages.set(pageNum, true);
            
            console.log(`Page ${pageNum} rendered`);
            
        } catch (error) {
            console.error(`Error rendering page ${pageNum}:`, error);
        }
    }
    
    async renderVisiblePages() {
        const pagesContainer = document.getElementById('pages-container');
        const containerRect = pagesContainer.getBoundingClientRect();
        const pageWrappers = document.querySelectorAll('.page-wrapper');
        
        this.visiblePages.clear();
        
        pageWrappers.forEach((wrapper, index) => {
            const rect = wrapper.getBoundingClientRect();
            const isVisible = rect.right > containerRect.left && rect.left < containerRect.right;
            
            if (isVisible) {
                this.visiblePages.add(index + 1);
            }
        });
        
        // Render visible pages plus buffer
        const pagesToRender = new Set();
        this.visiblePages.forEach(pageNum => {
            for (let i = Math.max(1, pageNum - this.renderBuffer); 
                 i <= Math.min(this.totalPages, pageNum + this.renderBuffer); 
                 i++) {
                pagesToRender.add(i);
            }
        });
        
        // Queue pages for rendering
        for (const pageNum of pagesToRender) {
            if (!this.renderedPages.has(pageNum)) {
                this.renderQueue.push(pageNum);
            }
        }
        
        this.processRenderQueue();
    }
    
    async processRenderQueue() {
        if (this.isRendering || this.renderQueue.length === 0) return;
        
        this.isRendering = true;
        
        while (this.renderQueue.length > 0) {
            const pageNum = this.renderQueue.shift();
            await this.renderPage(pageNum);
        }
        
        this.isRendering = false;
    }
    
    updateVisiblePages() {
        if (!this.pdf) return;
        
        const pagesContainer = document.getElementById('pages-container');
        const containerRect = pagesContainer.getBoundingClientRect();
        const pageWrappers = document.querySelectorAll('.page-wrapper');
        
        let newCurrentPage = this.currentPage;
        let minDistance = Infinity;
        
        pageWrappers.forEach((wrapper, index) => {
            const rect = wrapper.getBoundingClientRect();
            const pageNum = index + 1;
            
            // Calculate distance from center of container
            const pageCenter = rect.left + rect.width / 2;
            const containerCenter = containerRect.left + containerRect.width / 2;
            const distance = Math.abs(pageCenter - containerCenter);
            
            if (distance < minDistance) {
                minDistance = distance;
                newCurrentPage = pageNum;
            }
        });
        
        if (newCurrentPage !== this.currentPage) {
            this.currentPage = newCurrentPage;
            this.updatePageInfo();
        }
        
        // Lazy render pages that come into view
        this.renderVisiblePages();
    }
    
    updatePageInfo() {
        document.getElementById('current-page').textContent = this.currentPage;
        document.getElementById('total-pages').textContent = this.totalPages || '-';
        
        // Update navigation button states
        document.getElementById('prev-page').disabled = this.currentPage <= 1;
        document.getElementById('next-page').disabled = this.currentPage >= this.totalPages;
    }
    
    previousPage() {
        if (this.currentPage > 1) {
            this.goToPage(this.currentPage - 1);
        }
    }
    
    nextPage() {
        if (this.currentPage < this.totalPages) {
            this.goToPage(this.currentPage + 1);
        }
    }
    
    goToPage(pageNum) {
        if (pageNum < 1 || pageNum > this.totalPages) return;
        
        const pageWrapper = document.querySelector(`[data-page-number="${pageNum}"]`);
        if (pageWrapper) {
            pageWrapper.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'nearest',
                inline: 'center'
            });
        }
    }
    
    zoomIn() {
        if (this.zoomLevel < this.maxZoom) {
            this.setZoom(Math.min(this.zoomLevel + 0.25, this.maxZoom));
        }
    }
    
    zoomOut() {
        if (this.zoomLevel > this.minZoom) {
            this.setZoom(Math.max(this.zoomLevel - 0.25, this.minZoom));
        }
    }
    
    fitToWidth() {
        const pagesContainer = document.getElementById('pages-container');
        const containerWidth = pagesContainer.clientWidth - 32; // Account for padding
        
        if (this.pdf) {
            this.pdf.getPage(1).then(page => {
                const viewport = page.getViewport({ scale: 1.0 });
                const scale = containerWidth / viewport.width;
                this.setZoom(Math.max(this.minZoom, Math.min(scale, this.maxZoom)));
            });
        }
    }
    
    async setZoom(newZoom) {
        if (newZoom === this.zoomLevel) return;
        
        this.zoomLevel = newZoom;
        document.getElementById('zoom-level').textContent = Math.round(this.zoomLevel * 100) + '%';
        
        // Update zoom button states
        document.getElementById('zoom-in').disabled = this.zoomLevel >= this.maxZoom;
        document.getElementById('zoom-out').disabled = this.zoomLevel <= this.minZoom;
        
        // Clear rendered pages cache and re-render
        this.renderedPages.clear();
        
        // Re-render visible pages with new zoom
        await this.renderVisiblePages();
    }
    
    handleKeyboardNavigation(e) {
        // Don't handle if user is typing in search
        if (e.target.tagName === 'INPUT') return;
        
        switch (e.key) {
            case 'ArrowLeft':
                e.preventDefault();
                this.previousPage();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.nextPage();
                break;
            case 'Home':
                e.preventDefault();
                this.goToPage(1);
                break;
            case 'End':
                e.preventDefault();
                this.goToPage(this.totalPages);
                break;
            case '+':
            case '=':
                e.preventDefault();
                this.zoomIn();
                break;
            case '-':
                e.preventDefault();
                this.zoomOut();
                break;
            case '0':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this.fitToWidth();
                }
                break;
            case 'Escape':
                this.closeSurahPanel();
                break;
        }
    }
    
    // Touch gesture handling
    handleTouchStart(e) {
        if (e.touches.length === 1) {
            this.touchStartX = e.touches[0].clientX;
            this.touchStartY = e.touches[0].clientY;
            this.isSwipeGesture = true;
        } else {
            this.isSwipeGesture = false;
        }
    }
    
    handleTouchMove(e) {
        if (!this.isSwipeGesture || e.touches.length !== 1) return;
        
        const touchCurrentX = e.touches[0].clientX;
        const touchCurrentY = e.touches[0].clientY;
        
        const deltaX = Math.abs(touchCurrentX - this.touchStartX);
        const deltaY = Math.abs(touchCurrentY - this.touchStartY);
        
        // If vertical movement is greater, it's not a horizontal swipe
        if (deltaY > deltaX) {
            this.isSwipeGesture = false;
        }
    }
    
    handleTouchEnd(e) {
        if (!this.isSwipeGesture || e.changedTouches.length !== 1) return;
        
        const touchEndX = e.changedTouches[0].clientX;
        const deltaX = touchEndX - this.touchStartX;
        const minSwipeDistance = 50;
        
        if (Math.abs(deltaX) > minSwipeDistance) {
            if (deltaX > 0) {
                this.previousPage();
            } else {
                this.nextPage();
            }
        }
        
        this.isSwipeGesture = false;
    }
    
    handleResize() {
        // Debounce resize handling
        clearTimeout(this.resizeTimeout);
        this.resizeTimeout = setTimeout(() => {
            this.renderVisiblePages();
        }, 300);
    }
    
    // Theme management
    toggleTheme() {
        this.isDarkTheme = !this.isDarkTheme;
        document.documentElement.setAttribute('data-theme', this.isDarkTheme ? 'dark' : 'light');
        localStorage.setItem('quran-viewer-theme', this.isDarkTheme ? 'dark' : 'light');
    }
    
    loadTheme() {
        const savedTheme = localStorage.getItem('quran-viewer-theme');
        this.isDarkTheme = savedTheme === 'dark';
        document.documentElement.setAttribute('data-theme', this.isDarkTheme ? 'dark' : 'light');
    }
    
    // Surah navigation
    initializeSurahNavigation() {
        const surahList = document.getElementById('surah-list');
        
        window.SURAH_DATA.forEach(surah => {
            const surahItem = document.createElement('div');
            surahItem.className = 'surah-item';
            surahItem.dataset.surahNumber = surah.number;
            
            surahItem.innerHTML = `
                <div class="surah-info">
                    <div class="surah-name">${surah.number}. ${surah.name}</div>
                    <div class="surah-arabic">${surah.arabic}</div>
                    <div class="surah-meta">${surah.meaning} • ${surah.revelation} • ${surah.verses} verses</div>
                </div>
                <button class="jump-btn" data-page="${surah.endPage}" title="Jump to end of ${surah.name}">
                    Jump to End
                </button>
            `;
            
            // Click handlers
            surahItem.addEventListener('click', (e) => {
                if (e.target.classList.contains('jump-btn')) {
                    const targetPage = parseInt(e.target.dataset.page);
                    this.goToPage(targetPage);
                    this.closeSurahPanel();
                } else {
                    this.goToPage(surah.startPage);
                    this.closeSurahPanel();
                }
            });
            
            surahList.appendChild(surahItem);
        });
    }
    
    toggleSurahPanel() {
        const panel = document.getElementById('surah-panel');
        panel.classList.toggle('open');
    }
    
    closeSurahPanel() {
        const panel = document.getElementById('surah-panel');
        panel.classList.remove('open');
    }
    
    filterSurahs(query) {
        const surahItems = document.querySelectorAll('.surah-item');
        const lowercaseQuery = query.toLowerCase();
        
        surahItems.forEach(item => {
            const surahNumber = item.dataset.surahNumber;
            const surah = window.SURAH_DATA.find(s => s.number == surahNumber);
            
            const searchText = `${surah.name} ${surah.meaning} ${surah.arabic}`.toLowerCase();
            const matches = searchText.includes(lowercaseQuery) || surah.number.toString().includes(lowercaseQuery);
            
            item.style.display = matches ? 'flex' : 'none';
        });
    }
    
    // Loading and error states
    showLoading() {
        document.getElementById('loading-spinner').style.display = 'block';
        document.getElementById('error-message').style.display = 'none';
        document.getElementById('pages-container').style.display = 'none';
    }
    
    hideLoading() {
        document.getElementById('loading-spinner').style.display = 'none';
        document.getElementById('pages-container').style.display = 'flex';
    }
    
    showError() {
        document.getElementById('loading-spinner').style.display = 'none';
        document.getElementById('error-message').style.display = 'block';
        document.getElementById('pages-container').style.display = 'none';
    }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.quranViewer = new QuranPDFViewer();
});

// Service worker registration for offline support (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => console.log('SW registered'))
            .catch(registrationError => console.log('SW registration failed'));
    });
}