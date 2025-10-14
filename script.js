// Mobile Toggle
document.addEventListener('DOMContentLoaded', function() {
  const hamburgerMenu = document.querySelector('.hamburger-menu');
  const navLinks = document.querySelector('.nav-links');

  if (hamburgerMenu && navLinks) {
    hamburgerMenu.addEventListener('click', function() {
      hamburgerMenu.classList.toggle('active');
      navLinks.classList.toggle('active');
    });

    // Close menu on click
    const navLinksItems = navLinks.querySelectorAll('a');
    navLinksItems.forEach(link => {
      link.addEventListener('click', function() {
        hamburgerMenu.classList.remove('active');
        navLinks.classList.remove('active');
      });
    });

    // Close mobile menu outside
    document.addEventListener('click', function(event) {
      if (!hamburgerMenu.contains(event.target) && !navLinks.contains(event.target)) {
        hamburgerMenu.classList.remove('active');
        navLinks.classList.remove('active');
      }
    });
  }
});

