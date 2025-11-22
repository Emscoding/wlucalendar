/* Define structure DATA type to represent name and value as key value pair.
 * char name[20] - name string, used as key for hash table
 * int value - value
 */
typedef struct {
    char name[20];
    int value;
} DATA;

/* Define structure NODE as linked list node to represent hash data the same hashed value.
 * DATA data - data field in node structure
 * next - pointer to the next node.
 */
typedef struct hnode {
    DATA data;
    struct hnode *next;
} HNODE;

/*  Define HASHTABLE structure type for linked hash table
 *  int size  --  hash table size, i.e., the modular or length of index array
 *  int count --  number of data elements in the hash table
 *  NODE **hna -- pointer pointing to the array of HNODE pointers.
 */
typedef struct hashtable {
    int size;
    int count;
    HNODE **hna;
} HASHTABLE;

/* Hash function that hash key string to an integer of modular of hash table size
 * @param key - input key string
 * @param size - modular value
 * @return  - (sum of ASCII code value the key string modular) % size
 */
int hash(char *key, int size){
unsigned int sum = 0;
    for (int i = 0;i<strlen(key);i++){
        sum += (unsigned char) key[i];}
    return sum % size;
}

/* Create dynamically a chained hash table of the given size
 * @param size  --  hash table size, i.e., the length of index array.
 * @return - pointer to dynamically allocated HASHTABLE object.
 */
HASHTABLE *new_hashtable(int size){
    
}

/* Insert key value data into HASHTABLE.
 * @param ht - pointer to a HASHTABLE
 * @param data - data to insert
 * #return - when keyed data exists, update its value and return 0;
 *           otherwise insert into the hash table and return 1
 */
int hashtable_insert(HASHTABLE *ht, DATA data){}

/* Search the hash table and return the pointer of found hnode
 * @param ht - pointer to a HASHTABLE
 * @param name - key to search
 * @return - pointer to the found HNODE, otherwise NULL
 */
HNODE *hashtable_search(HASHTABLE *ht, char *name){}

/* Delete hashnode by key.
 * @param ht - pointer to a HASHTABLE
 * @param name - name key for deletion
 * @return - if the named data exists, delete it and return 1; otherwise return 0.
 */
int hashtable_delete(HASHTABLE *ht, char *key){}

/* Clean all linked lists and reset the count to 0
 * @param ht - pointer to a HASHTABLE
 */
void hashtable_clean(HASHTABLE **ht){}

