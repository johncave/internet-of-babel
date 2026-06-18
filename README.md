# Computer of Babel

The Computer of Babel is a retro-futuristic "Desktop Computer" UI where all work is automated. It was designed to replicate the feeling of buying a new computer, then sitting down, figuring out what you can do with it, and how it works. 

Since all work tasks are automated in Babelcom, the hope is you can put it on a second monitor or something, then go do something you love: Art, cooking, creating something cool. 

## Background

This project was born when I got an Intel Compute Stick and found out it is the worst computer ever made. I thought about how to make the worst computer ever made do "something" and came up with the idea of using it as an "AI Supercomputer". Computer of Babel was born to be the "UI" of that computer from the future.

The AI Supercomputer is slowly filling the Library of Babel, using a tiny LLM, slowly writing all articles that exist. Oh, and Clippy is there slowly going mad, because Babelcom is exactly the computer Clippy always thought you had. 

## Computing History
The LLM is being run on the CPU of an [Intel Compute Stick](https://en.wikipedia.org/wiki/Intel_Compute_Stick), probably the most dingus computer ever made. It will complete the task exactly 0% slower than a top of the range AI supercomputer. 

## Code 
- **babelcom** is a supposed interface to *babelcom*, this computer that's tasked with this job. It can monitor real time output of the system with some usage graphs. 
- **librarian** small Go app that takes a folder of generated Title.md files and turns them into a useable site.
- **worker** runs on *babelcom* (the actual computer), generating output and telling the world about it through babelcom. 