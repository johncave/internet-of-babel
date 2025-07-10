// Radio App Component
const RadioApp = {
    init: function(container, config) {
        this.container = container;
        this.config = config;
        this.render();
    },

    render: function() {
        this.container.innerHTML = `
            <div class="radio-container">
                <h1>Radio</h1>
                <div class="radio-iframe-container">
                    <iframe 
                        src="https://radio.johncave.co.nz/public/night/embed"
                        frameborder="0"
                        allowfullscreen
                        class="radio-iframe">
                    </iframe>
                </div>
                
            </div>
        `;
    }
}; 