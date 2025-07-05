# Internet of Babel

A tiny computer is tasked with filling the Internet of Babel. It is given a list of starting titles for encyclopedia entries, and then from the entry, generates a list of titles that page should link to. These titles are then fed back into the LLM.

Inspired by a similar project called Google. 

## Computing History
The LLM is being run on the CPU of an [Intel Compute Stick](https://en.wikipedia.org/wiki/Intel_Compute_Stick), probably the most dingus computer ever made. It will complete the task exactly 0% slower than a top of the range AI supercomputer. 

## Code 
- **babelcom** is a supposed interface to *babelcom*, this computer that's tasked with this job. It can monitor real time output of the system with some usage graphs. 
- **librarian** small Go app that takes a folder of generated Title.md files and turns them into a useable site.
- **worker** runs on *babelcom* (the actual computer), generating output and telling the world about it through babelcom. 