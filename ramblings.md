- self healing 
- assure route's working well for top 10 sellers

- tax route 5% of subtotal


Create a self healing system, that will access route top merchants websites (currently it will be only scheels.com) and will validate the live experience of the widget. As the requirement of this tool to be self healed, we need a way to before running a e2e test over the website, we will crawl the website's data to identify buttons and other links that will help us setup the test environment.
Currently if I select an item and go to the chart, it will already display routes widget with a value, that's waht we want to validate, this whole flow.
Some modals or pop-ups will surely appear, we need a way to handle them as well, close or accept, so that doesn't block the add-to-cart experience.
Let's boilerplate a solution for that, using Node.JS, so we can go, access the website and check/uncheck the route widget with success.

We want this running on an e2e solution, from past experiences I'm ok with using playwright.